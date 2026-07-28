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
  // Multi-draft slots add a version-specific system instruction and accepted
  // prior drafts, so the full prompt is unique to that slot. Let those calls
  // opt out of paying for a cache entry that another slot cannot reuse.
  cachePrompt?: boolean;
  // "none" means no explicit reasoning override. This avoids excluding a
  // provider that cannot accept OpenRouter's reasoning controls when the writer
  // model changes. A ReasoningEffort explicitly opts the thin path into it.
  reasoning: "none" | ReasoningEffort;
};

export type DraftWriterResponse = {
  text: string;
  finishReason: string | null;
  usage?: Usage;
  model?: string;
};

/** Tool-free by construction: the adapter interface exposes no tools field. */
export interface DraftWriterAdapter {
  write(request: DraftWriterRequest): Promise<DraftWriterResponse>;
}

export const openRouterDraftWriter: DraftWriterAdapter = {
  async write(request) {
    // reasoning === "none": send NO reasoning-related field at all. completeChat
    // then applies its own per-model default (GLM → High, which GLM self-limits;
    // everything else → nothing). We deliberately do NOT send
    // `reasoning: { enabled: false }` for non-GLM models: the request also carries
    // `provider: { require_parameters: true }`, so OpenRouter only routes to
    // providers accepting EVERY parameter — and `enabled: false` is not a valid
    // reasoning shape for some models (Gemini 3.x maps reasoning.effort →
    // thinkingLevel and rejects enabled:false), which returns a 400 Bad Request.
    // That 400 is exactly what broke google/gemini-3.6-flash as a writer model:
    // every primary attempt 400'd in ~145ms and fell back to Sonnet. The
    // reasoning-DEFAULT over-reasoning case (deepseek-v4-pro burning the whole
    // budget) can only occur under the auto-router, where the writer already pins
    // Sonnet→Luna (model-config writerPrimary), so no writer call runs a
    // reasoning-default model; the 6k max_tokens ceiling is the remaining
    // backstop. An explicit ReasoningEffort ("medium"/"minimal", thin path) is
    // still passed through — those ARE valid across models.
    const result = await completeChat({
      messages: request.messages,
      model: request.model,
      maxTokens: request.maxTokens,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      sessionId: request.sessionId,
      cachePrompt: request.cachePrompt,
      ...(request.reasoning === "none"
        ? {}
        : { reasoningEffort: request.reasoning }),
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
      model: result.model,
    };
  },
};
