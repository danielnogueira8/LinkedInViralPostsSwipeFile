// Decode one server-owned transport envelope around a scraped LinkedIn post.
// Tool output is fenced before it reaches the general agent; source-modeling
// paths then call this helper before deterministic structure analysis and
// re-fence the resulting body at their own model boundary.
export function canonicalScrapedPostText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  const match = text.match(
    /^<post\b[^>]*>\r?\n?([\s\S]*?)\r?\n?<\/post>$/i,
  );
  if (!match) return text;
  return match[1].replace(/<\\\/post>/gi, "</post>").trim();
}
