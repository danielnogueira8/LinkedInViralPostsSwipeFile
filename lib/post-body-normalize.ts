const SENTENCE_SPLIT_RE = /(?<=[a-z0-9"'”’)\]])([.!?])\s+(?=["'“‘(A-Z0-9])/g;
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

export function normalizePostBody(body: string): string {
  const trimmed = normalizeSentenceFinalNumberBreaks(
    normalizeNumberedListicleHeadings(body.replace(/\s+$/, "")),
  );
  if (/\n/.test(trimmed)) return trimmed;
  if (trimmed.length < 220) return trimmed;
  const withBreaks = trimmed.replace(SENTENCE_SPLIT_RE, "$1\n\n");
  return withBreaks.includes("\n\n") ? withBreaks : trimmed;
}
