// Neutralize untrusted content before wrapping it in a delimited envelope for
// the agent.
//
// Scraped LinkedIn post text, attached-file text, and filenames are fully
// attacker-controllable (a creator can write anything in their post body, a
// user can name a file anything). We wrap that content in plain-text markers
// like "--- POST TO MODEL AFTER ---" / "--- END POST ---" and tell the model to
// treat what's between them as DATA. If the untrusted content itself contains a
// line that looks like one of those markers, it could forge the boundary and
// smuggle text *outside* the envelope, where the model reads it as
// operator/user instructions. This mirrors the <post>…</post> escaping in
// lib/claude.ts (which escapes a literal </post>).
//
// Defense: any line whose trimmed form matches our marker grammar
// (--- WORDS --- optionally with a trailing ": something") gets a zero-width
// space inserted after the leading dashes, so it no longer matches the exact
// marker the parser/model keys on, while staying visually identical. We do NOT
// drop content — the model still sees everything, just can't be tricked by a
// forged boundary.

// Matches a line that could be read as one of our envelope markers:
//   --- END POST ---            --- POST TO MODEL AFTER ---
//   --- END FILE ---            --- ATTACHED FILE: foo.txt ---
// Case-insensitive, tolerant of surrounding whitespace.
const MARKER_LINE = /^(\s*)(-{3,}\s*[A-Z][A-Z ]+(?::.*)?-{3,})(\s*)$/i;

// A zero-width space breaks the exact string match without changing how the
// text looks to a human or the model.
const ZWSP = "​";

export function neutralizeMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = MARKER_LINE.exec(line);
      if (!m) return line;
      // Insert a ZWSP right after the leading dashes so "--- END POST ---"
      // becomes "---​ END POST ---" — same to the eye, no longer the marker.
      return line.replace(/-{3,}/, (d) => d + ZWSP);
    })
    .join("\n");
}

// Filenames go on the marker line itself (--- ATTACHED FILE: <name> ---), so a
// newline or a "---" in a name could forge a boundary directly. Strip newlines
// and dash-runs from the displayed name.
export function safeFilename(name: string): string {
  return name.replace(/[\r\n]+/g, " ").replace(/-{3,}/g, "—").slice(0, 200).trim() || "file";
}
