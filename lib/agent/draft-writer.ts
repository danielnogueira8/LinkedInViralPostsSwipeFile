import {
  completeChat,
  type ChatMessage,
  type Usage,
} from "@/lib/openrouter";
export {
  FALLBACK_DRAFT_WRITER_MODEL,
  PRIMARY_DRAFT_WRITER_MODEL,
  THIN_DRAFT_WRITER_FALLBACK_MODEL,
  THIN_DRAFT_WRITER_MODEL,
} from "@/lib/agent/model-config";

// Mirrors completeChat's reasoningEffort union (openrouter.ts). Kept local so
// this module doesn't depend on an un-exported inline type.
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

// Drafting models default to the one app-wide chat model (OPENROUTER_CHAT_MODEL)
// so drafting uses the SAME model as everything else unless pinned via the
// per-writer env vars in model-config.ts. The fallback stays a DIFFERENT model on purpose: a
// fallback is the cross-model safety net for when the primary's provider fails
// or its circuit opens, so it must not be the same model as the primary (a
// same-model "fallback" is useless — the same outage takes both out).

// THIN PATH writer models. The thin drafting path (see draft-engine `lean`
// mode) runs the writer with reasoning ON and no taste machinery, so its raw
// output matches a plain Claude/ChatGPT chat. The primary now defaults to
// OPENROUTER_CHAT_MODEL too (one model everywhere); pin OPENROUTER_THIN_WRITER_MODEL
// if you want the thin writer on a different (e.g. stronger) model than the rest
// of the app. Env-overridable so a retired preview slug is a one-line env change
// (OpenRouter drops `-preview` slugs on graduation — see
// lead-magnet-image-generation.ts). `anthropic/claude-sonnet-5` is the fallback.

export type DraftWriterStage = "primary" | "repair" | "fallback";

export type DraftWriterRequest = {
  stage: DraftWriterStage;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  sessionId?: string;
  // "none" means no explicit reasoning override. This avoids excluding a
  // provider that cannot accept OpenRouter's reasoning controls when the writer
  // model changes. A ReasoningEffort explicitly opts the thin path into it.
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
      sessionId: request.sessionId,
      ...(request.reasoning === "none"
        ? {}
        : { reasoningEffort: request.reasoning }),
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
    };
  },
};
