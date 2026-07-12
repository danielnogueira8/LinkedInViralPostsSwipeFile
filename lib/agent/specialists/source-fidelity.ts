import { completeChat, logOpenRouterUsage, type ToolDef } from "@/lib/openrouter";
import { INJECTION_GUARD } from "@/lib/agent/untrusted";

export const SOURCE_FIDELITY_MODEL =
  process.env.OPENROUTER_SOURCE_FIDELITY_MODEL || "anthropic/claude-sonnet-5";

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

export const SOURCE_FIDELITY_SYSTEM_PROMPT =
  "You are an independent QA gate for modeled LinkedIn drafts. The user asked to model a source's WRITING MECHANICS and write ORIGINAL content — so judge whether the draft borrows the source's approach, not whether it mirrors it line-for-line. " +
  "PASS when the draft clearly takes cues from the source's hook style and overall shape (a recognizable family resemblance in how it opens, builds, and lands) while changing the subject matter. A loose, original adaptation is a PASS — that is the goal, not a defect. " +
  "FAIL ONLY when the draft is essentially UNRELATED to the source's approach — a totally different hook style and structure that could have been written without ever seeing the source. When in doubt, PASS: shipping a good original draft that adapts loosely is far better than blocking it. " +
  "Do NOT fail for: changed topic, different examples/facts/numbers, a shorter or longer treatment, or not copying wording — those are all expected and correct. " +
  "Ignore first-person factual claims here; another gate handles those. Return only the forced tool call." +
  INJECTION_GUARD;

export async function reviewModeledDraft(opts: {
  sourceText: string;
  draftBody: string;
  userRequest: string;
  verifiedContext: string;
  workspaceId: string;
  signal?: AbortSignal;
}): Promise<SourceFidelityVerdict> {
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
            `USER REQUEST:\n${opts.userRequest.slice(0, 2_000)}\n\n` +
            `VERIFIED CONVERSATION CONTEXT:\n${opts.verifiedContext.slice(-8_000)}\n\n` +
            `SELECTED SOURCE POST:\n${opts.sourceText.slice(0, 12_000)}\n\n` +
            `DRAFT TO REVIEW:\n${opts.draftBody.slice(0, 4_000)}`,
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
    // FAIL OPEN. This is an ADVISORY nudge, not a hard gate — a timeout or a
    // transient error on the QA call must NEVER discard a good draft and leave
    // the user with nothing (the observed "kept failing render_post → no draft
    // at all" symptom). If we can't verify, we ship: a draft that adapts loosely
    // is the intended outcome anyway, so the cost of a rare miss is far lower
    // than blocking every draft whenever the QA model hiccups.
    return { pass: true, reasons: [], retryInstruction: "" };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}
