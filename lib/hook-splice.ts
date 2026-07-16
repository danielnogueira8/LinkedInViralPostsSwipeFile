// Hook-only refine helpers — shared between the client artifact handler
// (app/(app)/dashboard/chat-workspace.tsx) and the server stream route
// (app/api/chats/[id]/stream/route.ts) so client + server splice the same
// way byte-for-byte.
//
// The user problem this closes: click "Tighten the hook" on a draft's
// suggestion card → the model rewrites the WHOLE post (new body, dropped
// paragraphs, different examples) even when told to touch only the opener.
// The prompt-level "don't rewrite the body" instruction was unreliable, so
// this file does it deterministically: take ONLY the model's new opener
// and glue it onto the ORIGINAL body byte-for-byte. The body cannot drift.
//
// These functions are the byte-identical port of the pre-existing client
// helpers in chat-workspace.tsx; the client now re-exports from here so
// there's a single source of truth (and one test surface).

// Max lines that count as "the hook" WITHIN the first paragraph. The user's
// mental model + LinkedIn's "…see more" reality is that the hook is the
// opening ~2 lines.
export const HOOK_LINE_COUNT = 2;

// Split a body into [hook, rest] for hook-only refine preservation.
//
// The hook is the first PARAGRAPH (the block before the first blank line),
// capped at the first `n` lines within it. The boundary NEVER crosses a
// blank-line paragraph break — the earlier "first n content lines" version
// counted across paragraphs, so on the dominant LinkedIn shape (one sentence
// per paragraph, blank-line separated) it swallowed the 2nd paragraph into
// the hook and a hook refine then DELETED it. Paragraph-aware fixes that.
//
// `rest` = everything from the blank line after paragraph 1 onward (the full
// body), preserved verbatim; PLUS any lines of paragraph 1 beyond line `n`
// (rare — a >2-line opening paragraph). Blank separators between hook and
// rest are normalized to one canonical blank line. Returns rest = "" when
// there's nothing past the hook to preserve. Pure. Tolerates CRLF by
// normalizing to \n first.
export function splitHookLines(
  body: string,
  n: number = HOOK_LINE_COUNT,
): { hook: string; rest: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  // Skip any leading blank lines so an empty opener doesn't consume the budget.
  let firstContent = 0;
  while (firstContent < lines.length && lines[firstContent].trim() === "") {
    firstContent++;
  }
  // End of the first PARAGRAPH: the first blank line at/after firstContent.
  let paraEnd = firstContent;
  while (paraEnd < lines.length && lines[paraEnd].trim() !== "") paraEnd++;
  // The hook is at most `n` lines of that first paragraph.
  const hookEnd = Math.min(firstContent + n, paraEnd);
  // Everything after the hook lines is preserved: the remainder of paragraph 1
  // (if it ran past `n`) + all later paragraphs. Skip the blank separator run so
  // the rest has no leading blanks and we re-join with one canonical blank line.
  let restStart = hookEnd;
  while (restStart < lines.length && lines[restStart].trim() === "") restStart++;
  const hook = lines.slice(firstContent, hookEnd).join("\n");
  const rest = lines.slice(restStart).join("\n");
  return { hook, rest };
}

// Guarantee a hook-only refine preserved the body: take the refined post's
// NEW hook (its first HOOK_LINE_COUNT content lines) and graft it onto the
// ORIGINAL body from the (HOOK_LINE_COUNT+1)-th content line on, so the body
// is preserved byte-for-byte (formatting included) even when the model
// rewrote the whole post. This is the deterministic backstop for "only
// touch the hook" — the model can't be trusted to leave the body alone,
// so we enforce it here. Pure.
//   - If the ORIGINAL has <= HOOK_LINE_COUNT content lines there's no body
//     to preserve → return refined unchanged.
//   - We ALWAYS graft (even if the refined hook matches the original),
//     because a hook refine must never let the body drift — the whole point
//     of this fix.
export function splicePreservedBody(
  originalBody: string,
  refinedBody: string,
): string {
  const orig = splitHookLines(originalBody);
  if (!orig.rest) return refinedBody; // <= 2 content lines: nothing to preserve
  // The refined opener = the refined post's first HOOK_LINE_COUNT content lines.
  const newHook = splitHookLines(refinedBody).hook;
  return `${newHook}\n\n${orig.rest}`;
}

// Detect a hook-focused refine instruction. When true, the client sends the
// server the source body + hookOnly:true so the server can splice, AND the
// user message gets enriched with a "rewrite ONLY the hook" prompt so the
// model gets the constraint at the prompt level (the splice is the backstop,
// not the primary mechanism).
export function isHookFocusedRefine(instruction: string): boolean {
  const t = instruction.toLowerCase();
  // The part being changed must be a hook-ish element AND the instruction
  // must not ask to touch the whole post (e.g. "rewrite the whole thing",
  // "make the post shorter" is body-wide, not hook-only).
  if (/\b(whole|entire|all of it|rewrite the post|the body|each paragraph|throughout)\b/.test(t)) {
    return false;
  }
  // Reliability finding: cta/call-to-action/closing-line/sign-off were
  // WRONGLY included here. The CTA sits at the END of the post — the
  // structural OPPOSITE of the hook (the opening 1-2 lines) — so a "stronger
  // CTA" or "add a disclaimer to the CTA" pick was misrouted through the
  // hook-only splice: the model was told "don't rewrite the body" (directly
  // contradicting the CTA instruction), and the server then grafted only the
  // model's first 1-2 lines onto the UNCHANGED original body, silently
  // discarding the requested CTA edit. Confirmed live: "Add a
  // connection-request disclaimer to the CTA" produced a hook rewrite
  // instead of a CTA change. Do not re-add cta/closing-line/sign-off terms.
  return /\b(hook|opener|opening|first line|first sentence|lede|lead-in)\b/.test(
    t,
  );
}

// Build the enriched user message a hook-only refine sends to the agent.
// Same shape as the per-card Refine button in chat-workspace.tsx's
// refineDraft() so the model gets the same constraint no matter whether the
// user clicked "Tighten the hook" in the ask-card OR the per-card refine
// button. Exported so both call sites share ONE prompt string.
export function buildHookOnlyRefineMessage(
  instruction: string,
  draftBody: string,
): string {
  const normalizedInstruction = instruction.trim();
  const sentenceBoundary = /[.!?…]$/.test(normalizedInstruction) ? " " : ". ";
  const instr =
    `${normalizedInstruction}${sentenceBoundary}Rewrite ONLY the hook — the first 1-2 lines. You may lightly adjust the next 1-2 lines so they still flow from the new hook, but leave the rest of the post EXACTLY as given: every other word and line break unchanged, blank lines between paragraphs kept. Do NOT rewrite the body.`;
  return (
    `Refine this post: ${instr}\n\n` +
    `Keep it in my voice. Here's the current post:\n` +
    `"""\n${draftBody}\n"""`
  );
}
