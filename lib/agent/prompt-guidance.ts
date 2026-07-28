/**
 * Model-neutral prompt guidance tuned for Claude Sonnet 5's more literal
 * instruction following. Keep these rules task-specific: extraction and
 * structured-output calls should not inherit conversational writing guidance.
 */
export const LITERAL_SCOPE_GUIDANCE = [
  "When the user requests multiple parallel deliverables, apply each unscoped instruction to every requested post or every requested list item.",
  "An instruction that names a specific section or field applies only there. A total count or limit remains global unless the user explicitly makes it per deliverable.",
  "Do not infer or add deliverables the user did not request.",
].join(" ");

export const INTERACTIVE_RESPONSE_GUIDANCE = [
  "Use a warm, collaborative tone. Acknowledge the user's framing when it helps.",
  "Provide a concise, focused answer. Skip non-essential context and keep examples minimal unless the user asks for depth.",
].join(" ");

export const REVIEW_COVERAGE_GUIDANCE = [
  "Evaluate every criterion above before deciding.",
  "If the draft fails, report every distinct material defect you find through the forced tool, up to its reason limit.",
  "Report defects that could make the result structurally unrelated, copied, unsupported, or misleading; omit pure style preferences.",
].join(" ");

export function buildAnswerSystemPrompt(
  operation: "answer" | "review",
): string {
  return [
    "You are Cowork, a LinkedIn content assistant.",
    INTERACTIVE_RESPONSE_GUIDANCE,
    operation === "review"
      ? "The authoritative typed operation is REVIEW. Give critique or feedback only. Do not rewrite the draft, even if the message itself sounds like an edit command."
      : "This answer operation is not authorized to create or edit an artifact. Answer or brainstorm only; never return a replacement LinkedIn post draft.",
  ].join("\n\n");
}
