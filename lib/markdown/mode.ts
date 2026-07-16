// Single source of truth for "should this draft be treated as markdown?".
//
// A draft written by a markdown-EMITTING model (GPT-5.6 Luna) carries
// `meta.markdown === true`, stamped at draft creation (PR 4). Every EGRESS point
// — the render preview (PR 2), the publish path, and the copy-to-clipboard
// buttons (PR 3) — asks THIS function, so the gate lives in exactly one place and
// a non-markdown model (Haiku / GLM / Gemini, meta.markdown absent) always takes
// the untouched legacy path.
//
// Deliberately tolerant of the jsonb `meta` being unknown/absent/malformed: the
// only thing that turns markdown ON is an explicit boolean-true flag. Anything
// else → false → today's exact behavior.

import { markdownToLinkedIn } from "@/lib/markdown/to-linkedin";

// The ONLY writer models that emit markdown we must convert. Add a model here
// (and nowhere else) to opt it into markdown handling. Everything absent —
// Haiku, GLM, Gemini, Qwen — writes LinkedIn-ready plain text already and takes
// the untouched legacy path, so flipping OPENROUTER_CHAT_MODEL back to any of
// them is a clean rollback. Matched case-insensitively against the full slug.
export const MARKDOWN_MODELS: readonly string[] = ["openai/gpt-5.6-luna"];

/**
 * Does this model emit markdown that our egress must normalize? This is the
 * gate PR 4 uses at DRAFT CREATION to decide whether to stamp meta.markdown
 * (which every egress point then reads via draftMarkdownEnabled). Kept separate
 * from the meta check so the "is this a markdown model" policy lives in one list.
 */
export function markdownModeForModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const slug = model.toLowerCase();
  return MARKDOWN_MODELS.some((m) => m.toLowerCase() === slug);
}

export function draftMarkdownEnabled(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return meta?.markdown === true;
}

/**
 * The body as it should EGRESS from the app — copied to clipboard or sent to
 * LinkedIn. For a markdown-model draft it's the LinkedIn-normalized form (Unicode
 * bold, "• " bullets, "text (url)" — no raw markdown); otherwise the body
 * verbatim. Use this at every point where a draft body leaves the app as text a
 * human will paste into LinkedIn, so copy and publish stay consistent.
 *
 * NOT for scraped/swipe-file post bodies — those never carry meta.markdown and
 * must never be run through the converter (it would corrupt a real post that
 * legitimately contains "*" or "#").
 */
export function draftEgressBody(
  body: string,
  meta: Record<string, unknown> | null | undefined,
): string {
  return draftMarkdownEnabled(meta) ? markdownToLinkedIn(body) : body;
}
