export const OPENAI_LUNA_MODEL = "openai/gpt-5.6-luna";
export const OPENAI_IMAGE_MODEL = "openai/gpt-image-2";
export const OPENAI_EMBEDDING_MODEL = "openai/text-embedding-3-small";

/**
 * Whether the configured slug can be served by the native OpenAI adapter.
 * Legacy Claude slugs return true because the adapter intentionally translates
 * them to Luna; this is a transport capability check, not a provider classifier.
 */
export function routesToNativeOpenAIModel(model: string): boolean {
  const value = model.trim().toLowerCase();
  return (
    value.startsWith("anthropic/") ||
    value.startsWith("claude-") ||
    value.startsWith("openai/") ||
    value.startsWith("gpt-") ||
    value.startsWith("o1") ||
    value.startsWith("o3") ||
    value.startsWith("o4") ||
    value.startsWith("text-embedding-")
  );
}

export function resolveNativeOpenAIPrimary(
  candidates: Array<string | undefined>,
  fallback = OPENAI_LUNA_MODEL,
  accepts: (model: string) => boolean = routesToNativeOpenAIModel,
): string {
  for (const candidate of candidates) {
    const model = candidate?.trim();
    if (model && accepts(model)) return model;
  }
  return fallback;
}

export function isOpenAIImageModel(model: string): boolean {
  return /^(?:openai\/)?gpt-image-/i.test(model.trim());
}

export function isOpenAIEmbeddingModel(model: string): boolean {
  return /^(?:openai\/)?text-embedding-/i.test(model.trim());
}
