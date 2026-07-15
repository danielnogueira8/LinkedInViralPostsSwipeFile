import {
  completeChat,
  logOpenRouterUsage,
  UsagePersistenceError,
  type ToolDef,
} from "@/lib/openrouter";
import {
  coworkAdapterHealth,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import { runCoworkAdapterAttempt } from "@/lib/agent/cowork-adapter-attempt";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import { editDraftBody, type EditorModelRewrite } from "./editor";
import { aiTellMetrics, looksCorruptedDraft } from "./nets";

// GLM-5.2, not Sonnet 5. AI-tell repair is a NARROW, forced-tool-schema copy
// edit ("fix only these listed AI-writing patterns in this draft") — a bounded
// rewrite, not open-ended judgment — so it doesn't need the frontier tier the
// decide/sameness/freshness judgment passes use. GLM-5.2 is ~2x cheaper in and
// ~2.4x cheaper out. Overridable via OPENROUTER_AI_TELL_MODEL if quality dips.
const DEFAULT_AI_TELL_MODEL = "z-ai/glm-5.2";

export function resolveAiTellModel(value = process.env.OPENROUTER_AI_TELL_MODEL): string {
  return value?.trim() || DEFAULT_AI_TELL_MODEL;
}

export const AI_TELL_MODEL = resolveAiTellModel();

export function aiTellRepairEnabled(): boolean {
  return process.env.AGENT_AI_TELL_REPAIR !== "0";
}

const AI_TELL_TIMEOUT_MS = Number(process.env.AGENT_AI_TELL_TIMEOUT_MS || 8000);

const REPAIR_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "return_repaired_post",
    description: "Return the minimally repaired LinkedIn post body.",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "The complete repaired post body." },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
};

function buildRewrite(
  workspaceId?: string,
  signal?: AbortSignal,
  maxChars = Number.POSITIVE_INFINITY,
  adapterHealth: AdapterHealthRegistry = coworkAdapterHealth,
  telemetry?: CoworkTurnTelemetry,
): EditorModelRewrite {
  return async ({ body, tells }) => {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(
      () => ctrl.abort(new DOMException("AI-tell deadline exceeded", "TimeoutError")),
      AI_TELL_TIMEOUT_MS,
    );

    try {
      const model = resolveAiTellModel();
      const result = await runCoworkAdapterAttempt({
        registry: adapterHealth,
        adapterKey: `cowork_finalizer_ai_tell:${model}`,
        signal,
        call: () =>
          completeChat({
            model,
            maxTokens: 2000,
            tools: [REPAIR_TOOL],
            forceTool: "return_repaired_post",
            signal: ctrl.signal,
            messages: [
              {
                role: "system",
                content:
                  "You are a surgical copy editor. Fix only the listed AI-writing patterns. " +
                  "Preserve every fact, claim, example, number, CTA, point of view, paragraph order, and the writer's voice. " +
                  "Do not add facts or generic polish. Keep roughly the same length. Return the entire post through the tool.",
              },
              {
                role: "user",
                content: `Patterns to fix: ${tells.join(", ")}\n\nPOST:\n${body}`,
              },
            ],
          }),
        validate: (res) => {
          const rewritten =
            typeof res.toolArgs?.body === "string"
              ? res.toolArgs.body.trim()
              : "";
          if (!rewritten || looksCorruptedDraft(rewritten)) {
            throw new Error("Invalid AI-tell repair output.");
          }
          if (rewritten.length > maxChars) {
            throw new Error("AI-tell repair exceeded the output limit.");
          }
          if (rewritten.length > Math.ceil(body.length * 1.4)) {
            throw new Error("AI-tell repair expanded the draft too far.");
          }
          if (aiTellMetrics(rewritten).length > 0) {
            throw new Error("AI-tell repair left blocked patterns.");
          }
          return rewritten;
        },
        persistUsage: async (res) => {
          if (workspaceId) {
            await logOpenRouterUsage(
              "ai-tell-repair",
              model,
              res.usage,
              workspaceId,
            );
          }
        },
        usage: (res) => res.usage,
        telemetry,
        stage: "finalizer_ai_tell",
        attempt: 1,
        model,
        rejectedReasonCode: "invalid_ai_tell_repair",
      });
      return result.value;
    } catch (error) {
      if (
        error instanceof UsagePersistenceError ||
        (error instanceof Error && error.name === "UsagePersistenceError")
      ) {
        throw error;
      }
      return null;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  };
}

export async function repairAiTells(opts: {
  body: string;
  workspaceId?: string;
  signal?: AbortSignal;
  maxChars?: number;
  adapterHealth?: AdapterHealthRegistry;
  telemetry?: CoworkTurnTelemetry;
}): Promise<{ body: string; repaired: boolean; detected: string[] }> {
  const detected = aiTellMetrics(opts.body);
  if (!aiTellRepairEnabled() || detected.length === 0) {
    return { body: opts.body, repaired: false, detected };
  }

  const result = await editDraftBody(opts.body, {
    useModel: true,
    modelRewrite: buildRewrite(
      opts.workspaceId,
      opts.signal,
      opts.maxChars,
      opts.adapterHealth,
      opts.telemetry,
    ),
  });
  return { body: result.body, repaired: result.usedModel, detected };
}
