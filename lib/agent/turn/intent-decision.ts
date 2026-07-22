import { z } from "zod";
import {
  completeChat,
  logOpenRouterUsage,
  providerModelAttribution,
} from "@/lib/openrouter";
import { INJECTION_GUARD, wrapUntrustedXml } from "@/lib/agent/untrusted";
import { parseJsonObject } from "@/lib/claude";

// ---------------------------------------------------------------------------
// Fallthrough intent-decision (Cowork intent-router durability, Piece 1).
//
// The deterministic regex router in compileTurnPlan classifies the clear-cut
// majority of turns for free. This is the model-based safety net for the ~5%
// it CAN'T classify — the turns that would otherwise drop into the tool-less
// `answer` lane and hallucinate (e.g. "edit the draft, remove the sentence on
// the hook"). ONE cheap GPT-Luna call, run ONLY on the fallthrough, that says
// what the user actually wants so the turn can route to a real lane — or, when
// genuinely ambiguous, ask the user with concrete options instead of guessing.
//
// Any error / timeout / malformed output returns null. The caller treats null
// as uncertainty and fails closed to a typed clarification; it never grants an
// executor authority based on a missing classifier result.
// ---------------------------------------------------------------------------

// GPT-Luna is this app's most stable model; env-tunable for rollback / testing.
export const INTENT_DECISION_MODEL =
  process.env.OPENROUTER_INTENT_MODEL?.trim() || "openai/gpt-5.6-luna";
export const INTENT_DECISION_ENABLED =
  process.env.INTENT_DECISION !== "0";

const INTENT_DECISION_TIMEOUT_MS = 8_000;
const INTENT_DECISION_MAX_TOKENS = 320;

export const FALLTHROUGH_INTENTS = [
  "edit_current_draft",
  "new_post",
  "board_action",
  "question",
  "ambiguous",
] as const;
export type FallthroughIntent = (typeof FALLTHROUGH_INTENTS)[number];

export type IntentDecision = {
  intent: FallthroughIntent;
  // Present only when intent === "ambiguous": the clarifying question + 2-4
  // concrete options to show the user instead of guessing.
  clarify?: { question: string; options: string[] };
};

const IntentDecisionSchema = z.object({
  intent: z.string(),
  clarify: z
    .object({
      question: z.string().trim(),
      options: z.array(z.string().trim()).optional(),
    })
    .optional(),
});

function isFallthroughIntent(value: unknown): value is FallthroughIntent {
  return (
    typeof value === "string" &&
    (FALLTHROUGH_INTENTS as readonly string[]).includes(value)
  );
}

// Validate + normalize the model's raw output. Pure + exported for tests.
// Returns null when the shape is unusable (→ caller asks). An "ambiguous"
// verdict without at least two real options is downgraded to null too: an ask
// with fewer than two choices is not usable, so the caller substitutes its
// deterministic clarification instead of rendering a broken card.
export function coerceIntentDecision(input: unknown): IntentDecision | null {
  const parsed = IntentDecisionSchema.safeParse(input);
  if (!parsed.success) return null;
  if (!isFallthroughIntent(parsed.data.intent)) return null;
  const intent = parsed.data.intent;
  if (intent !== "ambiguous") return { intent };

  const question = parsed.data.clarify?.question?.trim();
  const options = (parsed.data.clarify?.options ?? [])
    .map((option) => option.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!question || options.length < 2) return null;
  return { intent, clarify: { question, options } };
}

export type IntentDecisionInput = {
  userText: string;
  workspaceId: string;
  // Grounding — an isolated judge needs the same facts the router has, or it
  // hallucinates (the decision-layer #402 lesson). Whether a draft/source
  // exists changes what "edit it" even means.
  hasCurrentDraft: boolean;
  hasModelSource: boolean;
  signal?: AbortSignal;
};

function buildSystemPrompt(input: IntentDecisionInput): string {
  return [
    "You classify what a user wants from a single message in a LinkedIn content chat, so the app can route the turn. Output strict JSON only, no prose.",
    `Shape: {"intent": one of ${FALLTHROUGH_INTENTS.join(" | ")}, "clarify"?: {"question": string, "options": string[2-4]}}.`,
    "Definitions:",
    `- edit_current_draft: change / refine / shorten / fix / rework the post the chat is already working on.${input.hasCurrentDraft ? "" : " (No current draft exists this turn, so do NOT choose this.)"}`,
    "- new_post: write a brand-new, different post (or additional posts).",
    "- board_action: move, schedule, or organize saved drafts on the board — not writing.",
    "- question: a question, opinion, or brainstorm that does not ask to write or change a post.",
    "- ambiguous: you genuinely cannot tell which of the above they mean. ONLY then, include `clarify` with a short question and 2-4 concrete options.",
    input.hasModelSource
      ? "A source post is attached this turn; a plain 'edit it' likely refers to new work from that source, not the prior draft."
      : "",
    "Prefer a concrete intent; use ambiguous sparingly, only when a wrong guess would clearly misfire.",
    INJECTION_GUARD,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Decide what an otherwise-unroutable turn wants. Returns null on any failure
 * (the caller fails closed to clarification). Only call this on the
 * router's fallthrough — never on turns a deterministic lane already claimed.
 */
export async function decideFallthroughIntent(
  input: IntentDecisionInput,
): Promise<IntentDecision | null> {
  const trimmed = input.userText.trim();
  if (!trimmed) return null;

  try {
    const res = await completeChat({
      model: INTENT_DECISION_MODEL,
      maxTokens: INTENT_DECISION_MAX_TOKENS,
      timeoutMs: INTENT_DECISION_TIMEOUT_MS,
      glmReasoning: "none",
      messages: [
        { role: "system", content: buildSystemPrompt(input) },
        { role: "user", content: wrapUntrustedXml("message", trimmed) },
      ],
      signal: input.signal,
    });
    const attribution = providerModelAttribution(INTENT_DECISION_MODEL, res.model);
    await logOpenRouterUsage(
      "intent_decision",
      attribution.model,
      res.usage,
      input.workspaceId,
      attribution.metadata,
    );
    const raw = res.text.trim();
    if (!raw) return null;
    return coerceIntentDecision(parseJsonObject(raw));
  } catch (error) {
    // The caller converts classifier failure into a typed clarification.
    console.warn("decideFallthroughIntent failed:", (error as Error).message);
    return null;
  }
}
