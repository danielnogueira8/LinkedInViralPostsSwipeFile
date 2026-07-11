import { completeChat, logOpenRouterUsage, type ToolDef } from "@/lib/openrouter";
import { INJECTION_GUARD, wrapUntrustedXml } from "@/lib/agent/untrusted";

export const SOURCE_FIDELITY_MODEL =
  process.env.OPENROUTER_SOURCE_FIDELITY_MODEL || "openai/gpt-5.4-mini";

const TIMEOUT_MS = Number(process.env.AGENT_SOURCE_FIDELITY_TIMEOUT_MS || 8_000);

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

const PLACEHOLDER_RE = /\[[^\]\n]{2,80}\]|\{[^{}\n]{2,80}\}/;

export const SOURCE_FIDELITY_SYSTEM_PROMPT =
  "You are a strict, independent QA gate for modeled LinkedIn drafts. " +
  "Pass only when the draft preserves the selected source's hook pattern, rhetorical sequence, pacing, and ending function while changing the subject matter. " +
  "Fail when the draft merely names a source ID but uses an unrelated structure. " +
  "Use VERIFIED CONVERSATION CONTEXT only to validate first-person facts; if a claim is not supported there, fail it. " +
  "Do not require copied wording, examples, facts, or numbers. Return only the forced tool call." +
  INJECTION_GUARD;

export async function reviewModeledDraft(opts: {
  sourceText: string;
  draftBody: string;
  draftKind?: "post" | "hook";
  userRequest: string;
  verifiedContext: string;
  workspaceId: string;
  signal?: AbortSignal;
}): Promise<SourceFidelityVerdict> {
  if (PLACEHOLDER_RE.test(opts.draftBody)) {
    return {
      pass: false,
      reasons: ["The draft contains an unfilled placeholder."],
      retryInstruction: "Replace every placeholder with supported content or remove that claim.",
    };
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await completeChat({
      model: SOURCE_FIDELITY_MODEL,
      maxTokens: 500,
      tools: [VERDICT_TOOL],
      forceTool: "report_source_fidelity",
      signal: ctrl.signal,
      messages: [
        {
          role: "system",
          content: SOURCE_FIDELITY_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content:
            `DELIVERABLE KIND: ${opts.draftKind ?? "post"}\n` +
            "For a hook, judge only whether its opener pattern and tension adapt the source opener; do not require the full body sequence.\n\n" +
            wrapUntrustedXml("user-request", opts.userRequest.slice(0, 2_000)) +
            "\n\n" +
            wrapUntrustedXml("verified-context", opts.verifiedContext.slice(-8_000)) +
            "\n\n" +
            wrapUntrustedXml("selected-source", opts.sourceText.slice(0, 12_000)) +
            "\n\n" +
            wrapUntrustedXml("draft-to-review", opts.draftBody.slice(0, 4_000)),
        },
      ],
    });

    await logOpenRouterUsage(
      "source_fidelity",
      SOURCE_FIDELITY_MODEL,
      res.usage,
      opts.workspaceId,
    );

    const args = res.toolArgs ?? {};
    if (args.pass === true) {
      return { pass: true, reasons: [], retryInstruction: "" };
    }
    const reasons = Array.isArray(args.reasons)
      ? args.reasons.filter((x): x is string => typeof x === "string").slice(0, 4)
      : [];
    const retryInstruction =
      typeof args.retry_instruction === "string" ? args.retry_instruction.trim() : "";
    return {
      pass: false,
      reasons: reasons.length
        ? reasons
        : ["The draft does not preserve the selected source's structure."],
      retryInstruction:
        retryInstruction ||
        "Rewrite using the selected source's full hook-to-ending sequence without copying its subject matter.",
    };
  } catch {
    // Fail closed. A missing chip is recoverable; confidently attaching the
    // wrong source is not. The agent receives a retryable tool error and can
    // try the same verified source again.
    return {
      pass: false,
      reasons: ["Source-fidelity review could not complete."],
      retryInstruction:
        "Retry the modeled draft while preserving the selected source's structure exactly.",
    };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}
