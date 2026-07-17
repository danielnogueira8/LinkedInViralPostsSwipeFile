// A number immediately before the punctuation is virtually never a genuine
// sentence boundary — it's a date ("July 19."), an age, a list marker, or a
// decimal fragment, not the end of a clause. So this only splits after a
// LETTER (or closing punctuation) precedes the mark; numbers never trigger a
// split here. Real sentence boundaries elsewhere in the text still split fine.
const SENTENCE_SPLIT_RE = /(?<=[a-z"'”’)\]])([.!?])\s+(?=["'“‘(A-Z0-9])/g;
// Inline list markers that belong at the START of their own line on LinkedIn.
// The writer (Qwen or GLM) sometimes emits a list as one run-on line —
// "Here's what's inside: -> a -> b -> c" — instead of one item per line. On
// LinkedIn that renders as an unreadable wall; the source it was modeled from
// almost always had each "-> item" on its own line. We detect a line carrying
// TWO OR MORE of these markers mid-line and break before each marker so every
// item lands on its own line. Covers ASCII "->", the unicode arrows GLM likes
// (→ » ›), and bullet glyphs (• ▸ ‣). A single mid-line marker is left alone
// (it may be legitimate inline prose like "revenue -> profit").
const INLINE_LIST_MARKER = /->|[→➜➞»›▸‣•]/g;
// A marker only starts a list ITEM when it's followed by a space (or is glued to
// a word we then space-normalize). Used to split: capture the marker + trailing
// space so we can re-emit it at the head of the next line.
const INLINE_LIST_SPLIT_RE = /\s*(->|[→➜➞»›▸‣•])[ \t]+/g;
const NUMBERED_HEADING_ONLY_RE = /^(\s*)(\d{1,2})\.\s*$/;
const TRAILING_NUMBERED_HEADING_ONLY_RE = /^(\s*)(.+\S)\s+(\d{1,2})\.\s*$/;
const SENTENCE_FINAL_NUMBER_LINE_RE = /^(\s*)(\d{1,2})\.\s+(.+\S)\s*$/;
// Words whose line-final position means the NEXT number completes the same
// sentence ("deleted steps 3 through / 9. Activation…" — observed live, GLM
// breaks the line before a range's second number). A real numbered list is
// never preceded by a line ending in one of these without punctuation.
const NUMBER_EXPECTING_PREVIOUS_LINE_RE =
  /\b(?:turn|turned|turning|age|aged|was|were|am|is|are|be|been|being|became|become|hit|hits|reached|reaches|before|after|until|by|at|through|to|of|from|between|and|than)\s*$/i;
const SENTENCE_START_AFTER_NUMBER_RE =
  /^(?:->|[→»›]|["'“‘(]?[A-Z])/;

function isListicleHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 90) return false;
  if (/^['"“‘`]/.test(trimmed)) return false;
  if (/^(?:[-*•]|\d{1,2}\.)\s+/.test(trimmed)) return false;
  if (/[?]$/.test(trimmed)) return false;
  const words = trimmed.match(/[A-Za-z0-9][\w'’-]*/g) ?? [];
  return words.length >= 2 && words.length <= 12;
}

export function normalizeNumberedListicleHeadings(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const numberedOnly = lines[i].match(NUMBERED_HEADING_ONLY_RE);
    const trailingNumberedOnly = lines[i].match(TRAILING_NUMBERED_HEADING_ONLY_RE);
    if (trailingNumberedOnly) {
      let headingIndex = i + 1;
      while (headingIndex < lines.length && lines[headingIndex].trim() === "") {
        headingIndex++;
      }
      if (headingIndex < lines.length && isListicleHeadingLine(lines[headingIndex])) {
        const [, indent, leadIn, number] = trailingNumberedOnly;
        out.push(`${indent}${leadIn.trimEnd()}`);
        out.push(`${indent}${number}. ${lines[headingIndex].trim()}`);
        i = headingIndex;
        continue;
      }
    }
    if (!numberedOnly) {
      out.push(lines[i]);
      continue;
    }

    let headingIndex = i + 1;
    while (headingIndex < lines.length && lines[headingIndex].trim() === "") {
      headingIndex++;
    }
    if (headingIndex >= lines.length || !isListicleHeadingLine(lines[headingIndex])) {
      out.push(lines[i]);
      continue;
    }

    const [indent, number] = [numberedOnly[1], numberedOnly[2]];
    out.push(`${indent}${number}. ${lines[headingIndex].trim()}`);
    i = headingIndex;
  }
  return out.join("\n");
}

export function normalizeSentenceFinalNumberBreaks(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    const numberedSentence = current.match(SENTENCE_FINAL_NUMBER_LINE_RE);
    const previous = out[out.length - 1];
    if (
      numberedSentence &&
      previous !== undefined &&
      previous.trim() !== "" &&
      !/[.!?:;]$/.test(previous.trim()) &&
      NUMBER_EXPECTING_PREVIOUS_LINE_RE.test(previous) &&
      SENTENCE_START_AFTER_NUMBER_RE.test(numberedSentence[3])
    ) {
      const [, indent, number, rest] = numberedSentence;
      out[out.length - 1] = `${previous.trimEnd()} ${number}.`;
      out.push("");
      out.push(`${indent}${rest}`);
      continue;
    }
    out.push(current);
  }
  return out.join("\n");
}

// Split a body's run-on inline lists so each "-> item" / "→ item" lands on its
// own line. Operates line-by-line: a line is only rewritten when it carries TWO
// OR MORE list markers mid-line (a single marker stays inline — it may be prose
// like "MVP -> scale"). The text BEFORE the first marker (e.g. a lead-in like
// "Here's what's inside:") is kept as its own line, then each marked item
// follows on its own line with the marker preserved. Idempotent: a line that
// already has one-marker-per-line has at most one marker, so it's untouched.
export function normalizeInlineArrowLists(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const markers = line.match(INLINE_LIST_MARKER) ?? [];
    // Need 2+ item-markers on ONE line to call it a flattened list. A single
    // mid-line marker stays inline (it may be prose like "MVP -> scale"), and a
    // line that's already one item-per-line carries at most one marker → no-op,
    // which keeps this idempotent.
    if (markers.length < 2) {
      out.push(line);
      continue;
    }
    // Insert a break before every item-marker that FOLLOWS content on the line
    // (a space/word/punctuation before it). A marker already at the line start
    // isn't preceded by content, so it's left in place. `INLINE_LIST_SPLIT_RE`
    // only matches a marker followed by whitespace, so glyphs inside words
    // ("a->b" with no spaces) aren't touched.
    const broken = line.replace(
      INLINE_LIST_SPLIT_RE,
      (_match, marker: string) => `\n${marker} `,
    );
    for (const part of broken.split("\n")) {
      const trimmed = part.replace(/\s+$/, "");
      if (trimmed.trim() !== "") out.push(trimmed);
    }
  }
  return out.join("\n");
}

export function normalizePostBody(body: string): string {
  const trimmed = normalizeInlineArrowLists(
    normalizeSentenceFinalNumberBreaks(
      normalizeNumberedListicleHeadings(body.replace(/\s+$/, "")),
    ),
  );
  if (/\n/.test(trimmed)) return trimmed;
  if (trimmed.length < 220) return trimmed;
  const withBreaks = trimmed.replace(SENTENCE_SPLIT_RE, "$1\n\n");
  return withBreaks.includes("\n\n") ? withBreaks : trimmed;
}
