// Writer selection — the explicit "which writer applies to this turn" module.
//
// Today the writer guidance is chosen implicitly by keyword-triggered skill
// selection (skills/index.ts) plus the route's lead-magnet decision
// (shouldApplyLeadMagnetContext). That works, but "which writer" isn't a single
// named signal anywhere — it's spread across skill matching and route flags.
//
// This module formalizes it: given the deterministic signals the stream route
// ALREADY computes (whether lead-magnet context applies, and the user's text),
// it returns a single WriterOutputKind and the prompt-module label that governs
// that writer. It reuses the route's lead-magnet decision as an INPUT (passed in
// as `leadMagnetApplies`) rather than recomputing it, so there's no second copy
// of the lead-magnet regexes to drift.
//
// This PR is additive: the module + tests exist and are unit-tested, but the
// live path is unchanged. A later step wires selectWriterKind() into the loop so
// the editor/QA stages (PR 4+) can branch on a real writer kind. Keeping the
// wiring separate keeps this behavior-identical and reviewable.

import { WriterOutputKindSchema, type WriterOutputKind } from "./contracts";

// Hook-only requests: the user wants openers, not full posts. Mirrors the
// HOOKS skill triggers (skills/index.ts) so the two stay semantically aligned;
// kept as an explicit boundary regex here so writer selection is testable in
// isolation. Anchored on whole words to avoid matching "hooked on" prose.
const HOOK_INTENT_RE =
  /\b(hooks?|openers?|first line|opening lines?)\b/i;

// A request that is explicitly for a FULL post (not just hooks), which should
// override an incidental "hook" mention like "a post with a strong hook".
const FULL_POST_INTENT_RE =
  /\b(write|draft|create|make|model|adapt|rewrite|turn .* into)\b.*\bpost\b|\bpost\b.*\b(about|on)\b/i;

export type WriterSignals = {
  // The user's latest message text (lowercased or not — matched case-insensitively).
  userText: string;
  // Whether the route's lead-magnet decision (shouldApplyLeadMagnetContext) said
  // this turn is a lead-magnet post. Passed IN so we don't duplicate that logic.
  leadMagnetApplies: boolean;
};

// Decide which writer governs this turn.
//   - lead_magnet: the route already classified this as a giveaway post.
//   - hook:        the user asked for hooks/openers and NOT a full post.
//   - regular:     everything else (the default post writer).
//
// Precedence: lead-magnet wins over hook (a "lead magnet hook" is still a
// lead-magnet turn); a full-post request beats an incidental "hook" mention.
export function selectWriterKind(signals: WriterSignals): WriterOutputKind {
  if (signals.leadMagnetApplies) return "lead_magnet";
  const text = signals.userText;
  if (HOOK_INTENT_RE.test(text) && !FULL_POST_INTENT_RE.test(text)) {
    return "hook";
  }
  return "regular";
}

// The prompt-module label each writer kind maps to. These names correspond to
// the existing skill bodies in skills/index.ts (LEAD_MAGNET, HOOKS) and the
// always-on writing/structure skills for regular posts. Exposed so the loop and
// evals can assert "a lead-magnet turn uses the lead-magnet writer module"
// without reaching into skill-selection internals.
export const WRITER_PROMPT_MODULE = {
  regular: "post-structure+global-writing",
  lead_magnet: "lead-magnet",
  hook: "hooks",
} as const satisfies Record<WriterOutputKind, string>;

export function writerPromptModule(kind: WriterOutputKind): string {
  // Validate the kind at the boundary so a bad value fails loudly rather than
  // silently mapping to undefined.
  return WRITER_PROMPT_MODULE[WriterOutputKindSchema.parse(kind)];
}
