import {
  completeChat,
  type ChatMessage,
  type Usage,
} from "@/lib/openrouter";

// Mirrors completeChat's reasoningEffort union (openrouter.ts). Kept local so
// this module doesn't depend on an un-exported inline type.
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export const PRIMARY_DRAFT_WRITER_MODEL =
  process.env.OPENROUTER_DIRECT_WRITER_MODEL || "qwen/qwen3.7-plus";
export const FALLBACK_DRAFT_WRITER_MODEL =
  process.env.OPENROUTER_DIRECT_WRITER_FALLBACK_MODEL || "z-ai/glm-5.2";

// THIN PATH writer models. The thin drafting path (see draft-engine `lean`
// mode) deliberately uses a STRONG model with reasoning ON and no taste
// machinery, so its raw output matches what you'd get in a plain Claude/ChatGPT
// chat. Env-overridable so a retired preview slug is a one-line env change, not
// a deploy — OpenRouter drops `-preview` slugs on graduation (see
// lead-magnet-image-generation.ts). `google/gemini-3.1-pro-preview` verified
// live on OpenRouter's model list; `anthropic/claude-sonnet-5` is the fallback.
export const THIN_DRAFT_WRITER_MODEL =
  process.env.OPENROUTER_THIN_WRITER_MODEL || "google/gemini-3.1-pro-preview";
export const THIN_DRAFT_WRITER_FALLBACK_MODEL =
  process.env.OPENROUTER_THIN_WRITER_FALLBACK_MODEL || "anthropic/claude-sonnet-5";

export type DraftWriterStage = "primary" | "repair" | "fallback";

export type DraftWriterRequest = {
  stage: DraftWriterStage;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  // "none" disables reasoning (the legacy Qwen/GLM direct writer — those models
  // don't benefit and it keeps latency down). A ReasoningEffort keeps reasoning
  // ON, which is where a strong reasoning model (Gemini 3.1 Pro, Sonnet) earns
  // its quality — the thin path passes "medium".
  reasoning: "none" | ReasoningEffort;
};

export type DraftWriterResponse = {
  text: string;
  finishReason: string | null;
  usage?: Usage;
};

/** Tool-free by construction: the adapter interface exposes no tools field. */
export interface DraftWriterAdapter {
  write(request: DraftWriterRequest): Promise<DraftWriterResponse>;
}

export const openRouterDraftWriter: DraftWriterAdapter = {
  async write(request) {
    const result = await completeChat({
      messages: request.messages,
      model: request.model,
      maxTokens: request.maxTokens,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      ...(request.reasoning === "none"
        ? { disableReasoning: true }
        : { reasoningEffort: request.reasoning }),
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
    };
  },
};
