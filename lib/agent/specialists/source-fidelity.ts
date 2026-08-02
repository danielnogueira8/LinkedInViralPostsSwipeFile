import {
  CHAT_MODEL,
  completeChat,
  logOpenRouterUsage,
  UsagePersistenceError,
  type ToolDef,
} from "@/lib/openrouter";
import {
  coworkAdapterHealth,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import {
  runCoworkAdapterAttempt,
  providerModelAttribution,
} from "@/lib/agent/cowork-adapter-attempt";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import { distinctFallbackModel } from "@/lib/agent/model-routing";
import {
  INJECTION_GUARD,
  wrapUntrustedDelimited,
} from "@/lib/agent/untrusted";
import { REVIEW_COVERAGE_GUIDANCE } from "@/lib/agent/prompt-guidance";
import { resolveNativeOpenAIPrimary } from "@/lib/model-provider-routing";
import type { ModelSourceBlueprint } from "@/lib/agent/specialists/model-source-blueprint";

// Defaults to the one app-wide chat model (OPENROUTER_CHAT_MODEL) so every
// text-LLM call uses the SAME model unless pinned via
// OPENROUTER_SOURCE_FIDELITY_MODEL.
export const SOURCE_FIDELITY_MODEL = resolveNativeOpenAIPrimary(
  [
    process.env.OPENAI_SOURCE_FIDELITY_MODEL,
    process.env.OPENROUTER_SOURCE_FIDELITY_MODEL,
  ],
  CHAT_MODEL,
);
export const SOURCE_FIDELITY_FALLBACK_MODEL = distinctFallbackModel(
  SOURCE_FIDELITY_MODEL,
  process.env.OPENROUTER_SOURCE_FIDELITY_FALLBACK_MODEL ||
    "openai/gpt-5.6-luna",
  ["google/gemini-3.5-flash"],
);

// Per-reviewer deadline. This covers a NON-streaming forced-tool call whose
// whole JSON body must arrive before the timer fires, on a payload that can run
// to ~28k chars (source ≤12k + draft ≤8k + verified context 8k) against a
// reasoning-capable primary and a slower Sonnet-5 fallback. 12s was too tight —
// a normal-but-slow verdict tripped the deadline and discarded a good draft as
// "reviewer unavailable". 22s gives real headroom while staying far under the
// ~270s turn deadline (two reviewers = ~44s worst case). Env-overridable.
const TIMEOUT_MS = Number(process.env.AGENT_SOURCE_FIDELITY_TIMEOUT_MS || 22_000);

const VERDICT_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "report_source_fidelity",
    description: "Judge whether a modeled LinkedIn draft faithfully adapts its selected source.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pass", "reasons", "retry_instruction"],
      properties: {
        pass: { type: "boolean" },
        reasons: {
          type: "array",
          maxItems: 4,
          items: { type: "string" },
        },
        retry_instruction: { type: "string" },
      },
    },
  },
};

// Content quality and reviewer availability are deliberately disjoint. A
// provider timeout or malformed tool response is not evidence that a draft is
// unfaithful, and must never be fed back to the writer as a content defect.
export type SourceFidelityVerdict =
  | { outcome: "verified" }
  | {
      outcome: "rejected";
      reasons: string[];
      retryInstruction: string;
    }
  | { outcome: "unavailable" };

export type SourceFidelityRejection = {
  code: "source_fidelity" | "source_fidelity_unavailable";
  reason: string;
  retryInstruction?: string;
};

export type SourceFidelityDeliverableKind =
  | "post"
  | "hook"
  | "idea"
  | "angle"
  | "outline"
  | "title"
  | "opener";

export function buildSourceFidelityUserContent(opts: {
  sourceText: string;
  draftBody: string;
  userRequest: string;
  verifiedContext: string;
  blueprint?: ModelSourceBlueprint;
}): string {
  return [
    "Compare the selected source data with the candidate draft data under the authoritative request data below.",
    wrapUntrustedDelimited({
      label: "USER REQUEST DATA",
      endLabel: "END USER REQUEST DATA",
      text: opts.userRequest.slice(0, 2_000),
    }),
    wrapUntrustedDelimited({
      label: "VERIFIED CONVERSATION CONTEXT DATA",
      endLabel: "END VERIFIED CONVERSATION CONTEXT DATA",
      text: opts.verifiedContext.slice(-8_000),
    }),
    wrapUntrustedDelimited({
      label: "SELECTED SOURCE POST DATA",
      endLabel: "END SELECTED SOURCE POST DATA",
      text: opts.sourceText.slice(0, 12_000),
    }),
    ...(opts.blueprint
      ? [
          wrapUntrustedDelimited({
            label: "SERVER PREPARED MODEL SOURCE BLUEPRINT DATA",
            endLabel: "END SERVER PREPARED MODEL SOURCE BLUEPRINT DATA",
            text: JSON.stringify(opts.blueprint),
          }),
        ]
      : []),
    wrapUntrustedDelimited({
      label: "DRAFT TO REVIEW DATA",
      endLabel: "END DRAFT TO REVIEW DATA",
      text: opts.draftBody.slice(0, 8_000),
    }),
  ].join("\n\n");
}

const POST_FIDELITY_INSTRUCTIONS =
  "You are an independent QA gate for modeled LinkedIn drafts. The user asked to model a source's WRITING MECHANICS and write ORIGINAL content — so judge whether the draft borrows the source's approach, not whether it mirrors it line-for-line. " +
  "When SERVER PREPARED MODEL SOURCE BLUEPRINT DATA is present, it is the semantic acceptance contract: audit the overarching theme as a mechanism, communicative job, intended reader effect, hook function, evidence type, emotional/logical arc, and ordered beat roles before judging surface structure. " +
  "PASS only when the draft clearly preserves the source's communicative move, hook approach, ordered semantic progression, and ending role while changing the subject matter in original language. A matching paragraph count, cadence, list shape, or number pattern cannot compensate for a different communicative job. " +
  "Audit source-specific variables: people, companies, products, offers, audiences, clients, results, numbers, dates, locations, personal anecdotes, relationships, and calls to action. Each must be replaced with a verified user-relevant equivalent, generalized into an honest non-factual statement, or omitted while preserving its structural role. " +
  "FAIL when the draft is structurally unrelated to the source, copies substantial wording, sentences, or examples, OR retains a source-specific variable that the authoritative request and verified context do not support for this user. A shared broad topic is allowed only when the request explicitly calls for it. " +
  "Do not fail merely because the literal topic, examples, facts, or length changed; those changes are required when they preserve the same semantic role and make the post user-relevant. FAIL when a celebration becomes advice, a confession becomes an opinion, a case study becomes generic teaching, a result becomes tenure or effort, or any other genre/theme substitution changes what the post is doing. Ignore first-person factual claims here; another gate handles those. Return only the forced tool call.";

function partialFidelityInstructions(
  deliverableKind: Exclude<SourceFidelityDeliverableKind, "post">,
): string {
  const comparison =
    deliverableKind === "outline"
      ? "Judge whether each outline takes useful cues from the source's progression and organizing mechanics."
      : deliverableKind === "idea" || deliverableKind === "angle"
        ? "Judge whether each item draws a useful, recognizable idea or framing cue from the source without copying its subject matter."
        : "Judge whether each item takes useful cues from the source's hook or opening mechanics (pattern, tension, framing, or rhythm).";
  return (
    `You are an independent QA gate for a modeled LinkedIn ${deliverableKind} list. ` +
    `${comparison} The candidate is intentionally a partial deliverable, not a full post. ` +
    "Do NOT require it to reproduce a full-post opening, build, and landing. PASS when every numbered item has a recognizable family resemblance to the relevant source mechanics while remaining original. " +
    "FAIL when any item is unrelated to the source cues, copies source wording too closely, or merely mentions the same broad topic without adapting the requested mechanics. " +
    "Changed topic and original language are expected. Ignore first-person factual claims here; another deterministic gate handles them. Return only the forced tool call."
  );
}

export function buildSourceFidelitySystemPrompt(
  deliverableKind: SourceFidelityDeliverableKind = "post",
): string {
  return [
    deliverableKind === "post"
      ? POST_FIDELITY_INSTRUCTIONS
      : partialFidelityInstructions(deliverableKind),
    REVIEW_COVERAGE_GUIDANCE,
    INJECTION_GUARD,
  ].join("\n\n");
}

export const SOURCE_FIDELITY_SYSTEM_PROMPT =
  buildSourceFidelitySystemPrompt("post");

function fidelityFallback(
  deliverableKind: SourceFidelityDeliverableKind = "post",
): { reason: string; retryInstruction: string } {
  if (deliverableKind === "post") {
    return {
      reason: "The draft does not preserve the selected source's structure.",
      retryInstruction:
        "Rewrite using the selected source's full hook-to-ending sequence without copying its subject matter.",
    };
  }
  return {
    reason: `The ${deliverableKind} list does not preserve the relevant selected-source mechanics.`,
    retryInstruction: `Rewrite the complete requested ${deliverableKind} list using the relevant source cues. Return only the exact partial deliverable, not a full post.`,
  };
}

/**
 * Translate the reviewer contract once for every finalization path. This keeps
 * full posts and partial deliverables aligned on the security-sensitive rule
 * that unavailable verification is never equivalent to verified fidelity.
 */
export function sourceFidelityRejection(
  verdict: SourceFidelityVerdict,
  deliverableKind: SourceFidelityDeliverableKind = "post",
): SourceFidelityRejection | null {
  if (verdict.outcome === "verified") return null;
  if (verdict.outcome === "unavailable") {
    return {
      code: "source_fidelity_unavailable",
      reason:
        "Source fidelity could not be verified because both reviewers were unavailable.",
    };
  }
  const fallback = fidelityFallback(deliverableKind);
  return {
    code: "source_fidelity",
    reason: verdict.reasons.join(" ") || fallback.reason,
    retryInstruction: verdict.retryInstruction || fallback.retryInstruction,
  };
}

type SourceFidelityReviewOptions = {
  sourceText: string;
  draftBody: string;
  userRequest: string;
  verifiedContext: string;
  blueprint?: ModelSourceBlueprint;
  workspaceId: string;
  deliverableKind?: SourceFidelityDeliverableKind;
  signal?: AbortSignal;
  adapterHealth?: AdapterHealthRegistry;
  telemetry?: CoworkTurnTelemetry;
};

async function runSourceFidelityAttempt(
  opts: SourceFidelityReviewOptions,
  model: string,
  attempt: number,
): Promise<SourceFidelityVerdict> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(
    () =>
      ctrl.abort(
        new DOMException("Source-fidelity deadline exceeded", "TimeoutError"),
      ),
    TIMEOUT_MS,
  );

  try {
    const result = await runCoworkAdapterAttempt({
      registry: opts.adapterHealth ?? coworkAdapterHealth,
      adapterKey: `cowork_finalizer_source_fidelity:${model}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          // No prompt caching: measured net-negative: ~1,881 tokens written per call, ~6% ever read.
          // Reviewers fan out in PARALLEL (concurrent calls cannot read each other's
          // entry) and batches idle far past the 5-minute TTL.
          cachePrompt: false,
          model,
          maxTokens: 500,
          tools: [VERDICT_TOOL],
          forceTool: "report_source_fidelity",
          signal: ctrl.signal,
          messages: [
            {
              role: "system",
              content: buildSourceFidelitySystemPrompt(opts.deliverableKind),
            },
            {
              role: "user",
              content: buildSourceFidelityUserContent(opts),
            },
          ],
        }),
      validate: (res) => {
        const args = res.toolArgs as Record<string, unknown> | null;
        if (
          !args ||
          typeof args.pass !== "boolean" ||
          !Array.isArray(args.reasons) ||
          typeof args.retry_instruction !== "string"
        ) {
          throw new Error("Invalid source-fidelity verdict schema.");
        }
        if (args.pass) {
          return { outcome: "verified" as const };
        }
        const reasons = args.reasons
          .filter((value): value is string => typeof value === "string")
          .slice(0, 4);
        const retryInstruction = args.retry_instruction.trim();
        const fallback = fidelityFallback(opts.deliverableKind);
        return {
          outcome: "rejected" as const,
          reasons: reasons.length ? reasons : [fallback.reason],
          retryInstruction:
            retryInstruction || fallback.retryInstruction,
        };
      },
      persistUsage: (res) => {
        const attribution = providerModelAttribution(model, res.model);
        return logOpenRouterUsage(
          "source_fidelity",
          attribution.model,
          res.usage,
          opts.workspaceId,
          attribution.metadata,
        );
      },
      usage: (res) => res.usage,
      responseModel: (res) => res.model,
      telemetry: opts.telemetry,
      stage: "finalizer_source_fidelity",
      attempt,
      model,
      ...(attempt > 1 ? { fallbackReason: "reviewer_unavailable" } : {}),
      rejectedReasonCode: "invalid_source_fidelity_verdict",
      // A schema-invalid verdict here means the model failed to call the
      // tool correctly on THIS attempt (forceTool glitch, truncation,
      // model-specific tool-calling weakness) — it is not evidence the
      // provider is unreliable. Keeping it off this adapterKey's health
      // circuit stops a burst of tool-calling glitches from tripping the
      // breaker and silently degrading fidelity checks for unrelated
      // drafts/turns for the next openCooldownMs. A genuine "draft doesn't
      // match the source" verdict never reaches here as a throw (see the
      // pass:false branch above), and real transport failures (timeouts,
      // 5xx, rate limits) are unaffected — this only scopes out the
      // validate() throw path.
      validationFailureIsHealthNeutral: true,
    });
    return result.value;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}

export async function reviewModeledDraft(
  opts: SourceFidelityReviewOptions,
): Promise<SourceFidelityVerdict> {
  const models = [SOURCE_FIDELITY_MODEL, SOURCE_FIDELITY_FALLBACK_MODEL];
  for (const [index, model] of models.entries()) {
    try {
      return await runSourceFidelityAttempt(opts, model, index + 1);
    } catch (error) {
      if (
        error instanceof UsagePersistenceError ||
        (error instanceof Error && error.name === "UsagePersistenceError")
      ) {
        throw error;
      }
      if (opts.signal?.aborted) return { outcome: "unavailable" };
    }
  }
  return { outcome: "unavailable" };
}
