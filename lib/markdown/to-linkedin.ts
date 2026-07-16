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
// Only recognized markdown constructs are rewritten. Literal characters remain
// literal: hashtags, URL fragments, multiplication operators, and code content
// must survive byte-for-byte. A broad "remove markdown characters" cleanup is
// unsafe because the same characters have ordinary meanings in LinkedIn posts.
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
const RAW_URL_RE = /https?:\/\/[^\s<>()]+/g;

function protect(
  input: string,
  pattern: RegExp,
  namespace: "code" | "url",
): { text: string; restore: (value: string) => string } {
  const sentinelEnd = String.fromCodePoint(0xe001);
  let sentinelStart = String.fromCodePoint(0xe000);
  while (input.includes(`${sentinelStart}${namespace}`)) {
    sentinelStart += String.fromCodePoint(0xe000);
  }
  const values: string[] = [];
  const text = input.replace(pattern, (match, ...groups: unknown[]) => {
    const value = pattern === INLINE_CODE_RE && typeof groups[0] === "string"
      ? groups[0]
      : match;
    const token = `${sentinelStart}${namespace}${values.length}${sentinelEnd}`;
    values.push(value);
    return token;
  });
  return {
    text,
    restore: (value) =>
      value.replace(
        new RegExp(`${sentinelStart}${namespace}(\\d+)${sentinelEnd}`, "g"),
        (_match, index: string) => values[Number(index)] ?? "",
      ),
  };
}

function transformInline(line: string): string {
  // Code is literal, so protect it before any emphasis pass. Links are expanded
  // before raw URLs are protected, allowing emphasis in link labels while the
  // destination (including #fragments) remains untouched.
  const code = protect(line, INLINE_CODE_RE, "code");
  let out = code.text;
  out = out.replace(LINK_RE, (_m, text: string, url: string) => `${text} (${url})`);
  const urls = protect(out, RAW_URL_RE, "url");
  out = urls.text;
  out = out.replace(BOLD_RE, (_m, _marker, inner: string) =>
    toUnicodeStyle(inner, "bold"),
  );
  out = out.replace(ITALIC_UNDERSCORE_RE, (_m, inner: string) =>
    toUnicodeStyle(inner, "italic"),
  );
  out = out.replace(ITALIC_STAR_RE, (_m, inner: string) =>
    toUnicodeStyle(inner, "italic"),
  );
  return code.restore(urls.restore(out));
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
      out.push(toUnicodeStyle(text, "bold"));
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

  return out.join("\n");
}

// Map a run of leading spaces (list indentation) to a normalized 2-spaces/level.
function normalizeIndent(raw: string): string {
  const level = Math.floor(raw.replace(/\t/g, "  ").length / 2);
  return "  ".repeat(Math.min(level, 4));
}

/**
 * Test/guard helper: true when `text` still contains a recognized markdown
 * construct. Literal marker characters alone are not markdown.
 */
export function hasResidualMarkdown(text: string): boolean {
  return (
    /^\s{0,3}#{1,6}\s+/m.test(text) ||
    /^\s{0,3}>\s?/m.test(text) ||
    /^\s*[-*+]\s+/m.test(text) ||
    /^\s*`{3,}/m.test(text) ||
    /\[[^\]\n]+\]\([^)\s]+\)/.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /(\*\*|__)(?=\S)[^\n]+?(?<=\S)\1/.test(text) ||
    /(?<![*\w])\*(?=\S)[^*\n]+?(?<=\S)\*(?![*\w])/.test(text) ||
    /(?<![A-Za-z0-9_])_(?=\S)[^_\n]+?(?<=\S)_(?![A-Za-z0-9_])/.test(text)
  );
}
