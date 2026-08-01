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
// lead-magnet-image-generation.ts). `openai/gpt-5.6-luna` is the fallback.

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
  // Character boundary for the invariant leading portion of the flattened
  // system prompt. The Anthropic adapter can cache that prefix while leaving
  // request-selected skills and workspace context outside the cache entry.
  cacheSystemPrefixChars?: number;
  // "none" means no writer-specific override. Native OpenAI calls still receive
  // the centralized max/high policy in lib/openai.ts; fallback models retain
  // their provider-specific defaults. "sonnet-low" remains a compatibility hint
  // for the legacy Luna/OpenRouter route.
  reasoning: "none" | "sonnet-low" | ReasoningEffort;
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

function isLuna(model: string): boolean {
  return model.trim().toLowerCase().replace(/^openai\//, "") ===
    "gpt-5.6-luna";
}

export const openRouterDraftWriter: DraftWriterAdapter = {
  async write(request) {
    // reasoning === "none" deliberately sends no reasoning-related field on
    // the legacy OpenRouter route. Do not send `reasoning: { enabled: false }`:
    // the request carries `provider.require_parameters`, and some fallback
    // providers reject that shape. Native OpenAI calls apply their centralized
    // max/high policy in lib/openai.ts before this transport is reached.
    const reasoningEffort =
      request.reasoning === "sonnet-low"
        ? isLuna(request.model)
          ? "low"
          : undefined
        : request.reasoning === "none"
          ? undefined
          : request.reasoning;
    const result = await completeChat({
      messages: request.messages,
      model: request.model,
      maxTokens: request.maxTokens,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      sessionId: request.sessionId,
      cachePrompt: request.cachePrompt,
      cacheSystemPrefixChars: request.cacheSystemPrefixChars,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
      model: result.model,
    };
  },
};
