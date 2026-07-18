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
import {
  INJECTION_GUARD,
  wrapUntrustedDelimited,
} from "@/lib/agent/untrusted";

// Defaults to the one app-wide chat model (OPENROUTER_CHAT_MODEL) so every
// text-LLM call uses the SAME model unless pinned via
// OPENROUTER_SOURCE_FIDELITY_MODEL.
export const SOURCE_FIDELITY_MODEL =
  process.env.OPENROUTER_SOURCE_FIDELITY_MODEL || CHAT_MODEL;

const TIMEOUT_MS = Number(process.env.AGENT_SOURCE_FIDELITY_TIMEOUT_MS || 12_000);

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

export type SourceFidelityVerdict = {
  pass: boolean;
  reasons: string[];
  retryInstruction: string;
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
    wrapUntrustedDelimited({
      label: "DRAFT TO REVIEW DATA",
      endLabel: "END DRAFT TO REVIEW DATA",
      text: opts.draftBody.slice(0, 8_000),
    }),
  ].join("\n\n");
}

const POST_FIDELITY_INSTRUCTIONS =
  "You are an independent QA gate for modeled LinkedIn drafts. The user asked to model a source's WRITING MECHANICS and write ORIGINAL content — so judge whether the draft borrows the source's approach, not whether it mirrors it line-for-line. " +
  "PASS only when the draft clearly preserves the source's hook approach, ordered progression, and ending shape while changing the subject matter in original language. " +
  "Audit source-specific variables: people, companies, products, offers, audiences, clients, results, numbers, dates, locations, personal anecdotes, relationships, and calls to action. Each must be replaced with a verified user-relevant equivalent, generalized into an honest non-factual statement, or omitted while preserving its structural role. " +
  "FAIL when the draft is structurally unrelated to the source, copies substantial wording, sentences, or examples, OR retains a source-specific variable that the authoritative request and verified context do not support for this user. A shared broad topic is allowed only when the request explicitly calls for it. " +
  "Do not fail merely because the topic, examples, facts, or length changed; those changes are required when they preserve the same structural role and make the post user-relevant. Ignore first-person factual claims here; another gate handles those. Return only the forced tool call.";

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
  return (
    (deliverableKind === "post"
      ? POST_FIDELITY_INSTRUCTIONS
      : partialFidelityInstructions(deliverableKind)) + INJECTION_GUARD
  );
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

export async function reviewModeledDraft(opts: {
  sourceText: string;
  draftBody: string;
  userRequest: string;
  verifiedContext: string;
  workspaceId: string;
  deliverableKind?: SourceFidelityDeliverableKind;
  signal?: AbortSignal;
  adapterHealth?: AdapterHealthRegistry;
  telemetry?: CoworkTurnTelemetry;
}): Promise<SourceFidelityVerdict> {
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
      adapterKey: `cowork_finalizer_source_fidelity:${SOURCE_FIDELITY_MODEL}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          model: SOURCE_FIDELITY_MODEL,
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
          return { pass: true, reasons: [], retryInstruction: "" };
        }
        const reasons = args.reasons
          .filter((value): value is string => typeof value === "string")
          .slice(0, 4);
        const retryInstruction = args.retry_instruction.trim();
        const fallback = fidelityFallback(opts.deliverableKind);
        return {
          pass: false,
          reasons: reasons.length ? reasons : [fallback.reason],
          retryInstruction:
            retryInstruction || fallback.retryInstruction,
        };
      },
      persistUsage: (res) => {
        const attribution = providerModelAttribution(SOURCE_FIDELITY_MODEL, res.model);
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
      attempt: 1,
      model: SOURCE_FIDELITY_MODEL,
      rejectedReasonCode: "invalid_source_fidelity_verdict",
    });
    return result.value;
  } catch (error) {
    if (
      error instanceof UsagePersistenceError ||
      (error instanceof Error && error.name === "UsagePersistenceError")
    ) {
      throw error;
    }
    const fallback = fidelityFallback(opts.deliverableKind);
    return {
      pass: false,
      reasons: [
        opts.deliverableKind && opts.deliverableKind !== "post"
          ? `Source fidelity for the ${opts.deliverableKind} list could not be verified.`
          : "Source fidelity could not be verified.",
      ],
      retryInstruction:
        `${fallback.retryInstruction} Do not ship it until source fidelity is verified.`,
    };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}
