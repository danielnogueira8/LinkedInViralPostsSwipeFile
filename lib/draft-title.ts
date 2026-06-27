// Shared title derivation for board posts (chat_artifacts). A post's preview
// name (the card title) defaults to its first line, capped. Centralised so the
// create route, the PATCH route, and the "re-derive on body change" logic all
// agree on the exact rule.

export function deriveDraftTitle(body: string): string {
  return body.split("\n")[0].slice(0, 60).trim() || "Untitled post";
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
