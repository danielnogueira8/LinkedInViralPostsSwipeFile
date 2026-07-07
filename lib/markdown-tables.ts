export function normalizeCollapsedMarkdownTables(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => expandCollapsedTableLine(line))
    .join("\n");
}

function expandCollapsedTableLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return line;
  if (!/\|\s*:?-{2,}:?\s*\|/.test(trimmed)) return line;

  return trimmed
    .replace(/\s+\|\s*(?=:?-{2,}:?\s*\|)/g, "\n|")
    .replace(/\s+\|\s*(?=\d+[.)]?\s*\|)/g, "\n| ")
    .replace(/\n{3,}/g, "\n\n");
}
