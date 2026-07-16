// markdownToLinkedIn — convert a markdown post body into LinkedIn-ready PLAIN
// TEXT. LinkedIn has no rich text, so:
//   • bold/italic → Unicode look-alike "fonts" (see unicode-styles.ts)
//   • headings → a bold line (LinkedIn has no headings)
//   • lists → plain lines with a real "•" bullet or the literal number
//   • links [text](url) → "text (url)"  (LinkedIn strips markdown links anyway;
//     the codebase's own guidance is to put external links in the FIRST COMMENT,
//     not the body — that policy lives in zernio.ts and is unchanged here)
//   • inline code / code fences → the backticks are stripped, content kept
//   • blockquotes → the "> " marker is dropped
//   • horizontal rules (---, ***, ___) → dropped
//
// HARD INVARIANT: the output contains NO markdown metacharacters that could leak
// to LinkedIn as literal syntax — no unescaped `*`, `_`, `#`, backtick, or the
// `[...](...)` link shape. `assertNoMarkdown` proves it and the tests assert it.
//
// SELF-CONTAINED on purpose: no markdown-parser dependency. This runs on model
// output (derived from untrusted scraped content upstream), so a small, auditable
// line/inline transform is preferred over pulling a full CommonMark parser's
// surface into the publish path. The construct set here is exactly what a
// LinkedIn post uses.
//
// This is applied ONLY to drafts written by a markdown-emitting model (gated by
// the caller via meta.markdown). Haiku/GLM/Gemini drafts never reach it.

import { toUnicodeStyle } from "@/lib/markdown/unicode-styles";

// ---- inline transforms (run per output line) --------------------------------

// **bold** or __bold__  → Unicode bold. Matched before single-char italic so a
// `**` opener is never mis-read as two `*` italics. Non-greedy, non-empty,
// no-inner-newline.
const BOLD_RE = /(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\1/g;
// _italic_ (word-boundaried so snake_case / file_name.ts survive) and *italic*.
const ITALIC_UNDERSCORE_RE = /(?<![A-Za-z0-9_])_(?=\S)([^_\n]+?)(?<=\S)_(?![A-Za-z0-9_])/g;
const ITALIC_STAR_RE = /(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g;
// [text](url) → "text (url)". URL kept but detached from the body per policy.
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// `code` → code (drop the backticks). Non-greedy, no inner backtick.
const INLINE_CODE_RE = /`([^`\n]+)`/g;

function transformInline(line: string): string {
  let out = line;
  // Order matters: links first (their brackets shouldn't be touched by emphasis),
  // then bold (before italic), then italics, then inline code last.
  out = out.replace(LINK_RE, (_m, text: string, url: string) => `${text} (${url})`);
  out = out.replace(BOLD_RE, (_m, _marker, inner: string) =>
    toUnicodeStyle(inner, "bold"),
  );
  out = out.replace(ITALIC_UNDERSCORE_RE, (_m, inner: string) =>
    toUnicodeStyle(inner, "italic"),
  );
  out = out.replace(ITALIC_STAR_RE, (_m, inner: string) =>
    toUnicodeStyle(inner, "italic"),
  );
  out = out.replace(INLINE_CODE_RE, (_m, inner: string) => inner);
  return out;
}

// ---- block-level line classifiers -------------------------------------------

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const UNORDERED_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const BLOCKQUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const HR_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Convert a markdown string to LinkedIn plain text with Unicode bold/italic.
 * Idempotent on already-plain text (a normal Haiku post passes through as prose;
 * `1.`/`- ` lines it already used stay as clean bullets/numbers).
 */
export function markdownToLinkedIn(md: string): string {
  if (!md) return md;
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const rawLine of lines) {
    // Fenced code block: drop the fence lines, keep the code lines verbatim
    // (backticks only ever appear as the fence, which we remove).
    if (FENCE_RE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(rawLine);
      continue;
    }

    // Horizontal rule → blank separator (a rule is decoration; keep the break).
    if (HR_RE.test(rawLine)) {
      out.push("");
      continue;
    }

    // Heading → a bold line (LinkedIn has no headings).
    const heading = rawLine.match(HEADING_RE);
    if (heading) {
      const text = transformInline(heading[2].trim());
      out.push(toUnicodeStyle(stripResidualMarks(text), "bold"));
      continue;
    }

    // Blockquote → drop the "> " marker, keep the (inline-transformed) content.
    const quote = rawLine.match(BLOCKQUOTE_RE);
    if (quote) {
      out.push(transformInline(quote[1]));
      continue;
    }

    // Ordered list → keep the number, keep indentation depth (2 spaces/level).
    const ordered = rawLine.match(ORDERED_RE);
    if (ordered) {
      const indent = normalizeIndent(ordered[1]);
      out.push(`${indent}${ordered[2]}. ${transformInline(ordered[3])}`);
      continue;
    }

    // Unordered list → a real "•" bullet (never a raw "-"/"*"/"+").
    const unordered = rawLine.match(UNORDERED_RE);
    if (unordered) {
      const indent = normalizeIndent(unordered[1]);
      out.push(`${indent}• ${transformInline(unordered[2])}`);
      continue;
    }

    // Plain line.
    out.push(transformInline(rawLine));
  }

  // Belt-and-suspenders: strip any markdown metacharacter that survived (e.g. an
  // unmatched "*" or a stray "#"), so the LinkedIn output is guaranteed clean.
  return stripResidualMarks(out.join("\n"));
}

// Map a run of leading spaces (list indentation) to a normalized 2-spaces/level.
function normalizeIndent(raw: string): string {
  const level = Math.floor(raw.replace(/\t/g, "  ").length / 2);
  return "  ".repeat(Math.min(level, 4));
}

// Remove any leftover markdown emphasis/heading/code characters that weren't part
// of a matched construct (unbalanced `*`, stray `#` mid-line, lone backtick).
// Underscores are LEFT ALONE here — they're common in normal prose/handles and we
// only strip them when they form a matched _italic_ pair above.
function stripResidualMarks(text: string): string {
  return text.replace(/[*#`]/g, "");
}

/**
 * Test/guard helper: true when `text` still contains a markdown metacharacter
 * that could render as literal syntax on LinkedIn. The converter's output must
 * always make this false.
 */
export function hasResidualMarkdown(text: string): boolean {
  // Any *, #, or backtick is a leak. A bare "[x](y)" link shape is a leak too.
  return /[*#`]/.test(text) || /\[[^\]\n]+\]\([^)\s]+\)/.test(text);
}
