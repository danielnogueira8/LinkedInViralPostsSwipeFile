import {
  completeChat,
  type ChatMessage,
  type Usage,
} from "@/lib/openrouter";

export const PRIMARY_DRAFT_WRITER_MODEL =
  process.env.OPENROUTER_DIRECT_WRITER_MODEL || "qwen/qwen3.7-plus";
export const FALLBACK_DRAFT_WRITER_MODEL =
  process.env.OPENROUTER_DIRECT_WRITER_FALLBACK_MODEL || "z-ai/glm-5.2";

export type DraftWriterStage = "primary" | "repair" | "fallback";

export type DraftWriterRequest = {
  stage: DraftWriterStage;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  reasoning: "none";
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
      disableReasoning: true,
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
    };
  },
};
