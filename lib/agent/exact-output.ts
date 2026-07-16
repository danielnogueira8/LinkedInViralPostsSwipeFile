const EXACT_FINAL_LINE_RES = [
  /\b(?:end|finish|close)\s+(?:the\s+post\s+)?with\s+(?:(?:this|the)\s+)?exact\s+(?:final|last|closing)\s+line\s*:?[ \t]+(.+?)\s*$/iu,
  /\b(?:the\s+)?exact\s+(?:final|last|closing)\s+line\s+(?:must|should)\s+be\s*:?\s*(.+?)\s*$/iu,
  /\b(?:keep|leave|preserve|retain|maintain)\s+(?:the\s+)?exact\s+(?:final|last|closing)\s+line(?:\s+exactly)?\s*:?[ \t]+(.+?)\s*$/iu,
] as const;

function unquoteExactValue(value: string): string {
  const trimmed = value.trim();
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["`", "`"],
    ['"', '"'],
    ["“", "”"],
    ["'", "'"],
    ["‘", "’"],
  ];
  for (const [open, close] of pairs) {
    if (
      trimmed.length >= open.length + close.length &&
      trimmed.startsWith(open) &&
      trimmed.endsWith(close)
    ) {
      return trimmed.slice(open.length, -close.length).trim();
    }
  }
  return trimmed;
}

/** Extract a single-line, user-authored exact ending contract. */
export function requestedExactFinalLine(instruction: string): string | null {
  for (const pattern of EXACT_FINAL_LINE_RES) {
    const match = instruction.match(pattern);
    if (!match) continue;
    const line = unquoteExactValue(match[1]);
    if (line && !/[\r\n]/.test(line) && line.length <= 500) return line;
  }
  return null;
}

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?…]+$/u, "").trimEnd();
}

/**
 * Make the requested exact line the one and only terminal occurrence.
 * Near-matches that differ only in terminal punctuation are replaced; a line
 * omitted by the writer is appended without deleting the writer's conclusion.
 */
export function enforceExactFinalLine(body: string, exactLine: string): string {
  const normalizedBody = body.replace(/\r\n/g, "\n").trimEnd();
  if (!normalizedBody) return exactLine;
  const exactComparable = withoutTerminalPunctuation(exactLine);
  const lines = normalizedBody.split("\n");
  const retained = lines.filter((line) => {
    const trimmed = line.trim();
    return !(
      trimmed === exactLine ||
      (exactComparable &&
        withoutTerminalPunctuation(trimmed) === exactComparable)
    );
  });
  while (retained.at(-1)?.trim() === "") retained.pop();
  return retained.length > 0
    ? `${retained.join("\n")}\n\n${exactLine}`
    : exactLine;
}
