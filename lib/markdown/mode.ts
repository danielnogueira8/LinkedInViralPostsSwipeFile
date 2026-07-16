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

export function draftMarkdownEnabled(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return meta?.markdown === true;
}

import { markdownToLinkedIn } from "@/lib/markdown/to-linkedin";

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
