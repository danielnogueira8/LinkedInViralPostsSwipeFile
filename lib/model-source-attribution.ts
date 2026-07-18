export type ModeledSourceAttribution = {
  id: string;
  url: string | null;
};

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function modeledSourceAttribution(
  meta: Record<string, unknown> | undefined,
): ModeledSourceAttribution | null {
  if (meta?.source !== "model_source") return null;
  const id = typeof meta.source_post_id === "string"
    ? meta.source_post_id.trim()
    : "";
  if (!id) return null;
  return { id, url: safeHttpUrl(meta.source_url) };
}
