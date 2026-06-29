// ---------------------------------------------------------------------------
// Decision pre-pass — the "should I ask a clarifying question?" gate.
//
// GLM-5.2 is a capable WRITER but an unreliable DECIDER: the recurring
// instability (asking when it shouldn't / not asking when it should, missing an
// exact count, treating "draft 5" as idea-5) all lives in the plan/decide layer,
// not the writing layer. So before the GLM loop runs, we make ONE short,
// structured judgment call on a stronger model (Claude Sonnet 4.6 via
// OpenRouter) that does exactly one thing: decide whether the request is
// ambiguous enough to ask the user first, and if so, propose the question +
// options. The decision is a forced-tool-call (schema-validated structured
// output), and run.ts validates it again before surfacing — the model fills a
// form, our code decides what to do with it.
//
// Design rules that keep this STABLE (the whole point):
//   • FAIL OPEN. Any error/timeout/missing-key/malformed-output → return a
//     "don't ask, proceed" verdict so the turn falls through to GLM EXACTLY as
//     it does today. The decision layer can only ADD an ask; it can never break
//     a turn. A new provider dependency must not become a new outage surface.
//   • Thin context. We send the recent conversation + a focused decision prompt,
//     NOT the 14K-token agent SYSTEM_PROMPT. Keeps the call cheap (~a fraction
//     of a cent) and fast.
//   • Env-gated + tunable model, so it's a one-flag rollback and the model can
//     be swapped (e.g. to Haiku) without a code change.
// ---------------------------------------------------------------------------

import {
  completeChat,
  logOpenRouterUsage,
  estimateTokens,
  type ChatMessage,
  type ToolDef,
} from "@/lib/openrouter";

// Sonnet 4.6 on OpenRouter — chosen for judgment/instruction-following, which is
// where GLM is weakest. Overridable via env for A/B or a cheaper tier (Haiku).
export const DECISION_MODEL =
  process.env.OPENROUTER_DECISION_MODEL || "anthropic/claude-sonnet-4.6";

// Feature flag. Off by default → zero behavior change until explicitly enabled,
// so this can ship dark and be turned on per-environment.
export function decisionLayerEnabled(): boolean {
  return process.env.AGENT_DECISION_LAYER === "1";
}

// How long we'll wait on the decision call before giving up and proceeding to
// GLM. The pre-pass is latency we add BEFORE the main generation, so we cap it
// tightly — a slow decision call must not stall the whole turn.
const DECISION_TIMEOUT_MS = Number(
  process.env.AGENT_DECISION_TIMEOUT_MS || 6000,
);

// Only the last few turns matter for "is THIS request ambiguous" — and trimming
// keeps the call cheap and on-point. We cap both the count and per-message size.
const MAX_DECISION_TURNS = 6;
const MAX_MESSAGE_CHARS = 2000;

export type DecisionVerdict = {
  // True only when the request is ambiguous/consequential enough that asking
  // gives the user real control AND a wrong guess would waste a generation.
  shouldAsk: boolean;
  // Present when shouldAsk: the single clarifying question + 2-6 options. These
  // are fed through run.ts's buildAskQuestion (same validation as ask_user), so
  // shape mismatches degrade to "don't ask" rather than a broken card.
  question?: string;
  options?: string[];
  // The label of an "I'm satisfied / proceed however you think" escape option,
  // so picking it closes the card with no further model turn (mirrors ask_user).
  doneOption?: string;
  // One short line of why — for logs/debugging, never shown to the user.
  reasoning?: string;
};

const PROCEED: DecisionVerdict = { shouldAsk: false };

const DECISION_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "decide",
    description:
      "Record your decision about whether to ask the user a clarifying question before the assistant proceeds.",
    parameters: {
      type: "object",
      properties: {
        shouldAsk: {
          type: "boolean",
          description:
            "True ONLY if the request is genuinely ambiguous or has a consequential open choice where two reasonable interpretations would produce noticeably different output AND guessing wrong wastes the user's time. False for clear requests, trivial choices, or anything you can proceed on with a sensible default.",
        },
        question: {
          type: "string",
          description:
            "If shouldAsk: one short clarifying question (one sentence). Omit otherwise.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "If shouldAsk: 2-6 concrete, mutually-distinct answer options in the user's own words. Make the LAST option a let-me-decide escape (e.g. 'Use your best judgment'). Omit otherwise.",
        },
        doneOption: {
          type: "string",
          description:
            "If one option means 'just proceed / use your best judgment', repeat its EXACT label here so picking it needs no further work. Omit otherwise.",
        },
        reasoning: {
          type: "string",
          description: "One short line: why ask, or why proceed.",
        },
      },
      required: ["shouldAsk"],
    },
  },
};

const DECISION_SYSTEM = [
  "You are a routing gate for a LinkedIn-ghostwriting assistant. You do NOT write anything.",
  "Your ONLY job: decide whether the assistant should ask the user ONE clarifying question before it proceeds, or just proceed.",
  "",
  "Ask when (and only when) BOTH are true:",
  "  1) The request is genuinely ambiguous or has a consequential open choice — two reasonable readings would produce noticeably different output. Classic case: a bare number/reference against a list the assistant just produced ('draft 5' = idea #5 OR all 5?), an unclear whose-voice/which-source, or a missing essential like the topic.",
  "  2) Guessing wrong would waste a real generation (so it's worth one quick question).",
  "",
  "Do NOT ask when: the request is clear; the choice is trivial or has an obvious sensible default; the user already said 'just do it' / 'your call' / 'use your best judgment'; or you'd merely be confirming something you can infer. Default to PROCEEDING — over-asking is its own failure.",
  "",
  "If you ask: give 2-6 concrete options in the user's own words, and make the LAST option a let-me-decide escape, passed as doneOption too.",
  "Record your decision via the `decide` tool. Be decisive.",
].join("\n");

// Trim history to the recent, size-capped turns the decision actually needs.
function decisionContext(history: ChatMessage[]): ChatMessage[] {
  return history
    .slice(-MAX_DECISION_TURNS)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((b) => (b.type === "text" ? b.text : ""))
                .join(" ")
            : "";
      return {
        role: m.role,
        content: text.slice(0, MAX_MESSAGE_CHARS),
      } as ChatMessage;
    })
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0);
}

// Validate the model's raw tool args into a DecisionVerdict. Defensive: any
// shape that isn't a clean "ask" collapses to PROCEED, so a malformed decision
// can never surface a broken card.
export function parseDecision(
  toolArgs: Record<string, unknown> | null,
): DecisionVerdict {
  if (!toolArgs || typeof toolArgs !== "object") return PROCEED;
  if (toolArgs.shouldAsk !== true) return PROCEED;
  const question =
    typeof toolArgs.question === "string" ? toolArgs.question.trim() : "";
  const options = Array.isArray(toolArgs.options)
    ? toolArgs.options.filter((o): o is string => typeof o === "string")
    : [];
  // An "ask" with no usable question or fewer than 2 options is not actionable —
  // proceed rather than surface a half-built card (run.ts validates again too).
  if (!question || options.length < 2) return PROCEED;
  const doneOption =
    typeof toolArgs.doneOption === "string" ? toolArgs.doneOption.trim() : undefined;
  const reasoning =
    typeof toolArgs.reasoning === "string" ? toolArgs.reasoning.trim() : undefined;
  return {
    shouldAsk: true,
    question,
    options,
    ...(doneOption ? { doneOption } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

// The decision pre-pass. Returns a verdict; NEVER throws. On the disabled flag,
// any error, a timeout, or a missing API key, returns PROCEED so the turn falls
// through to GLM exactly as today.
export async function decideTurn(
  history: ChatMessage[],
  opts: { workspaceId: string; signal?: AbortSignal } = { workspaceId: "" },
): Promise<DecisionVerdict> {
  if (!decisionLayerEnabled()) return PROCEED;
  if (!process.env.OPENROUTER_API_KEY) return PROCEED;
  const context = decisionContext(history);
  if (context.length === 0) return PROCEED;

  // Bound the call: the external signal OR our own timeout, whichever first.
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), DECISION_TIMEOUT_MS);

  try {
    const res = await completeChat({
      model: DECISION_MODEL,
      maxTokens: 300,
      tools: [DECISION_TOOL],
      forceTool: "decide",
      messages: [
        { role: "system", content: DECISION_SYSTEM },
        ...context,
      ],
      signal: ctrl.signal,
    });
    // Attribute the (tiny) cost to the workspace, like every other model call.
    if (opts.workspaceId) {
      void logOpenRouterUsage("decide", DECISION_MODEL, res.usage, opts.workspaceId);
    }
    return parseDecision(res.toolArgs);
  } catch {
    // Fail open — a decision-layer error must degrade to today's behavior.
    return PROCEED;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onParentAbort);
  }
}

// Rough token footprint of a decision call, for the cost note in tests/docs.
export function decisionPromptTokens(history: ChatMessage[]): number {
  const ctx = decisionContext(history)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  return estimateTokens(DECISION_SYSTEM) + estimateTokens(ctx);
}
