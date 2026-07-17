// Shared title derivation for board posts (chat_artifacts). A post's preview
// name (the card title) defaults to its first line, capped. Centralised so the
// create route, the PATCH route, and the "re-derive on body change" logic all
// agree on the exact rule.

const TITLE_MAX = 60;

export function deriveDraftTitle(body: string): string {
  const firstLine = body.split("\n")[0].trim();
  if (firstLine.length <= TITLE_MAX) return firstLine || "Untitled post";
  // Cut on the last word boundary within budget rather than a raw char
  // slice, so the title reads as a summary ("Stop waiting for the
  // perfect…") instead of stopping mid-word. Falls back to a hard cut only
  // when there's no whitespace at all in the budget (one giant "word").
  const cut = firstLine.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.trim()}…`;
}

// Whether `title` looks auto-derived from `body` (rather than a name the user
// typed). True when it equals the body-derived title, or is empty / a generic
// "Untitled" placeholder. Used to decide if a body change should refresh the
// title: a manually-named post keeps its name; an auto-named one follows the
// first line.
export function isAutoDerivedTitle(
  title: string | null | undefined,
  body: string,
): boolean {
  const t = (title ?? "").trim();
  if (!t || t === "Untitled post" || t === "Untitled draft") return true;
  return t === deriveDraftTitle(body);
}
