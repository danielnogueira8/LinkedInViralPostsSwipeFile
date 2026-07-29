import { supabaseAdmin } from "./supabase";
import { holdWorkspaceCostClaims } from "./workspace-cost-claims";
import { providerModelAttribution } from "./agent/cowork-adapter-attempt";
import {
  isOpenAIEmbeddingModel,
  isOpenAIImageModel,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_IMAGE_MODEL,
  resolveNativeOpenAIPrimary,
} from "./model-provider-routing";
export { providerModelAttribution } from "./agent/cowork-adapter-attempt";

// ---------------------------------------------------------------------------
// OpenRouter client (OpenAI-compatible Chat Completions)
// ---------------------------------------------------------------------------
//
// The chat workspace runs on GLM-5.2 via OpenRouter. OpenRouter's API is
// OpenAI-compatible, so we talk to it with raw fetch against the Chat
// Completions endpoint rather than pulling in the `openai` SDK — keeps the
// dependency surface small and gives us direct control over SSE parsing for
// the streaming tool-calling loop.
//
// Model is a single config constant so swapping GLM-5.2 <-> Sonnet (or A/B'ing
// them) is a one-line change, per the cost analysis we did up front.

// Two tiers, both on OpenRouter:
//
// REASONING (GLM-5.2, $1.20/M in, $4.10/M out): the chat agent + voice
// synthesis — anything that reasons, drafts, or matches a creator's voice. We
// trialled Claude Sonnet 5 here for stronger instruction-following, but at
// ~5-8x GLM's output cost it was not worth it for the chat tier. Turn routing
// and Artifact intent compilation are deterministic server-owned modules.
// The $15/user monthly budget cap still applies (see rate-limit.ts).
//
// BACKGROUND (GLM-5.1): the mechanical/categorizing tasks — templatize a post
// (structure-preserving fill-in-the-blank) and extract a hook (excerpt + pick a
// pattern tag). They don't need frontier reasoning, so they stay on the cheap
// GLM tier (see BACKGROUND_MODEL below).
//
// Each is env-overridable for A/B or pinning (OPENROUTER_CHAT_MODEL etc.).
//
export const CHAT_MODEL = resolveNativeOpenAIPrimary([
  process.env.OPENAI_CHAT_MODEL,
  process.env.OPENROUTER_CHAT_MODEL,
]);

// Embedding model for the viral-learning retrieval loop. OpenAI serves this
// model directly. text-embedding-3-small is
// 1536-dim (must match db/migration-088 `vector(1536)`); a model swap that
// changes the width needs a matching migration + re-embed.
export const EMBEDDING_MODEL = resolveNativeOpenAIPrimary(
  [
    process.env.OPENAI_EMBEDDING_MODEL,
    process.env.OPENROUTER_EMBEDDING_MODEL,
  ],
  OPENAI_EMBEDDING_MODEL,
  isOpenAIEmbeddingModel,
);
export const EMBEDDING_DIM = 1536;

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

export type OpenRouterProviderPreferences = {
  // Omitted entirely when there's no pin, so OpenRouter uses its default
  // price+latency load-balancing across the model's provider pool.
  order?: string[];
  allow_fallbacks: boolean;
  require_parameters: boolean;
};

export class OpenRouterHttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    operation = "OpenRouter",
  ) {
    super(`${operation} ${status} ${statusText}`.trim());
    this.name = "OpenRouterHttpError";
  }
}

// Provider routing for OpenRouter. We DON'T pin a preferred provider by
// default anymore: pinning `order: ["novita"]` made OpenRouter try Novita
// FIRST for every call, and when Novita's GLM-5.2 endpoint is slow/queued the
// whole turn sat on it (the "simple post takes ages" symptom) instead of
// getting OpenRouter's fastest-available provider. With no order, OpenRouter
// load-balances across the model's provider pool by price+latency, which is
// what we want. `require_parameters: true` is the load-bearing guarantee: it
// keeps the request on providers that actually support tool_choice / structured
// output (the agent loop depends on those), so dropping the pin can't route us
// to a cheap endpoint that silently ignores tool calls.
//
// Re-pin without a deploy via OPENROUTER_PROVIDER_ORDER (comma-separated), e.g.
// "novita" or "novita,deepinfra", if a specific provider ever proves best.
export function openRouterProviderPreferences(): OpenRouterProviderPreferences {
  const order = (process.env.OPENROUTER_PROVIDER_ORDER ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    // Only include `order` when a pin is explicitly set — an empty array would
    // still signal a (degenerate) preference; omitting it is the true "no pin".
    ...(order.length ? { order } : {}),
    allow_fallbacks: true,
    require_parameters: true,
  };
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return key;
}

// OpenRouter recommends these attribution headers; harmless if the referer is
// a placeholder in dev.
function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
    "Content-Type": "application/json",
  };
  const referer = process.env.OPENROUTER_SITE_URL;
  if (referer) h["HTTP-Referer"] = referer;
  const title = process.env.OPENROUTER_SITE_NAME || "SwipeIn Chat";
  h["X-Title"] = title;
  return h;
}

// ---------------------------------------------------------------------------
// Transport resilience — bounded retry + stall detection.
//
// Both model calls (completeChat, streamChat) fire a single naked fetch with no
// retry and no timeout. A transient 429 / upstream 5xx / network blip throws
// straight out → a dead turn + a user toast, when a brief retry would paper over
// it invisibly. A connection that opens then STALLS blocks reader.read() until
// the function's 300s ceiling, with a dead Stop button. These helpers close both
// holes — carefully, because getting the streaming boundary wrong is harmful:
// we retry ONLY the connection phase (the fetch, before any byte is read), never
// after a delta has been yielded (a retry there would replay partial text).
// ---------------------------------------------------------------------------

// Retry tuning. Env-overridable so it can be dialed without a deploy.
const RETRY_MAX_ATTEMPTS = Number(process.env.OPENROUTER_RETRY_ATTEMPTS || 3); // total tries
const RETRY_BASE_MS = Number(process.env.OPENROUTER_RETRY_BASE_MS || 300);
const RETRY_CAP_MS = Number(process.env.OPENROUTER_RETRY_CAP_MS || 4000);
// HTTP statuses worth retrying: rate-limit + transient upstream/server errors.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Idle-stall watchdog: if a stream opens but no bytes arrive for this long, the
// connection has stalled — cancel the reader and surface a typed error instead
// of hanging to the 300s function ceiling. Generous, so a slow-but-alive
// generation (which keeps emitting tokens) is never killed. Env-overridable.
const STREAM_IDLE_TIMEOUT_MS = Number(
  process.env.OPENROUTER_STREAM_IDLE_MS || 45_000,
);
// Overall connection deadline as a backstop. Comfortably under the route's 300s
// maxDuration so we fail cleanly (typed error, finally runs) rather than getting
// hard-killed by the platform mid-turn.
const STREAM_DEADLINE_MS = Number(
  process.env.OPENROUTER_STREAM_DEADLINE_MS || 290_000,
);

// Is this thrown error one we should NOT retry? An AbortError means the caller
// (Stop button / request disconnect) or our own timeout cancelled it — retrying
// would fight an intentional stop. Everything else from a connect-phase fetch
// (a network TypeError) is transient and retryable.
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

// Pure backoff decision (exported for tests): given the attempt index, the
// response status (or null for a thrown network error), and an optional
// Retry-After header value, return how many ms to wait before the next try — or
// null to NOT retry (success, a non-retryable status, or attempts exhausted).
export function retryDelayMs(
  attempt: number, // 0-based: 0 = the first try just failed
  status: number | null,
  retryAfterHeader: string | null,
  rand = 0.5, // jitter source [0,1); injectable for deterministic tests
): number | null {
  if (attempt + 1 >= RETRY_MAX_ATTEMPTS) return null; // no tries left
  if (status !== null && !RETRYABLE_STATUS.has(status)) return null; // permanent
  // Honor Retry-After (seconds, or an HTTP-date we approximate as seconds) when
  // the server told us how long to wait — but cap it so we never block forever.
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, RETRY_CAP_MS);
    }
  }
  // Exponential backoff with full jitter: random in [base*2^n/2, base*2^n].
  const exp = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
  return Math.floor(exp / 2 + rand * (exp / 2));
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Fetch with bounded retry for the CONNECTION PHASE ONLY. Safe to use for both
// the non-streaming call and the streaming call's initial fetch, because fetch()
// resolves before any response body byte is read — so a retry here never
// replays streamed content. Retries transient statuses + network errors; never
// retries an abort. On a retryable !ok response we drain+close the body so the
// connection can be reused. Throws the last error when attempts are exhausted.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      // A non-OK response: decide whether to retry based on status.
      const delay = retryDelayMs(
        attempt,
        res.status,
        res.headers.get("retry-after"),
        Math.random(),
      );
      if (delay === null) return res; // not retryable (or out of tries) — let the caller handle !ok
      // Drain the error body so the socket frees up, then back off.
      await res.text().catch(() => undefined);
      console.log(
        JSON.stringify({
          openrouter_retry: { label, attempt: attempt + 1, status: res.status, delay_ms: delay },
        }),
      );
      await sleep(delay, init.signal);
      lastErr = new OpenRouterHttpError(res.status, res.statusText);
    } catch (e) {
      if (isAbortError(e)) throw e; // intentional cancel — do not retry
      lastErr = e;
      const delay = retryDelayMs(attempt, null, null, Math.random());
      if (delay === null) throw e;
      console.log(
        JSON.stringify({
          openrouter_retry: { label, attempt: attempt + 1, error: (e as Error).message, delay_ms: delay },
        }),
      );
      await sleep(delay, init.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenRouter request failed");
}

// ---------------------------------------------------------------------------
// Embeddings (the viral-learning retrieval loop)
// ---------------------------------------------------------------------------

export type EmbedResult = {
  // One vector per input, in the SAME order as `texts` (we sort the provider's
  // index-tagged response defensively so callers can zip by position).
  embeddings: number[][];
  model: string;
  promptTokens: number;
};

type RawEmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: { prompt_tokens?: number };
  // OpenRouter doesn't consistently document echoing a served-model field on
  // /embeddings (unlike /chat/completions, which reliably does — see
  // completeChat's `model` parsing above). Parsed opportunistically: if
  // present, it's the real served model; if absent, callers fall back to the
  // requested alias exactly as before this field was added.
  model?: string;
};

// Embed a batch of texts via OpenRouter's OpenAI-compatible /embeddings
// endpoint. Returns one vector per input in input order. Batches are the
// caller's responsibility (OpenRouter accepts an array input); keep a batch
// under a few hundred items so a single failure doesn't waste a huge call.
// Throws on a non-OK response or a malformed/short vector so a bad embed can
// never be silently persisted as a zero/partial vector.
// Default per-call timeout for an embedding request. Embeddings are fast, so a
// call that hasn't resolved in this long is a stalled connection, not slow work
// — and without a bound a stalled `/embeddings` hangs the CALLER (a chat turn,
// the daily pipeline) until the platform's function ceiling hard-kills it. This
// is the same "frozen turn" class the stream path already guards; embedText did
// not. Composed with any caller signal so Stop/disconnect still cancels early.
export const EMBED_TIMEOUT_MS = 20_000;

export async function embedText(
  texts: string[],
  opts: { model?: string; signal?: AbortSignal; workspaceId?: string; timeoutMs?: number } = {},
): Promise<EmbedResult> {
  if (texts.length === 0) {
    return { embeddings: [], model: opts.model || EMBEDDING_MODEL, promptTokens: 0 };
  }
  const model = opts.model || EMBEDDING_MODEL;
  const deadline = AbortSignal.timeout(Math.max(1, opts.timeoutMs ?? EMBED_TIMEOUT_MS));
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  {
    const { routesToNativeOpenAI, embedTextOpenAI } = await import("./openai");
    if (routesToNativeOpenAI(model)) {
      const result = await embedTextOpenAI(texts, { model, signal });
      for (const [index, vector] of result.embeddings.entries()) {
        if (vector.length !== EMBEDDING_DIM) {
          throw new Error(
            `OpenAI embeddings: vector ${index} has width ${vector.length}, expected ${EMBEDDING_DIM}`,
          );
        }
      }
      if (opts.workspaceId) {
        await logOpenRouterUsage(
          "embed_posts",
          result.model,
          { prompt_tokens: result.promptTokens },
          opts.workspaceId,
        );
      }
      return result;
    }
  }
  const res = await fetchWithRetry(
    `${OPENROUTER_BASE_URL}/embeddings`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model, input: texts }),
      signal,
    },
    "embedText",
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new OpenRouterHttpError(
      res.status,
      res.statusText,
      "OpenRouter embeddings",
    );
  }
  const parsed = (await res.json()) as RawEmbeddingResponse;
  const rows = parsed.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(
      `OpenRouter embeddings returned ${rows.length} vectors for ${texts.length} inputs`,
    );
  }
  // The API tags each vector with its input index. PLACE each vector at its own
  // index (rather than sort-then-zip-by-position): a sort with a duplicated or
  // gapped `index` would pass the count check yet silently mis-assign a vector
  // to the wrong text — a wrong-but-stored embedding, the worst failure mode. A
  // missing/duplicate/out-of-range index is a hard error instead.
  const slots: Array<number[] | undefined> = new Array(texts.length);
  for (const row of rows) {
    const idx = row.index;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= texts.length) {
      throw new Error(`OpenRouter embeddings: invalid index ${String(idx)} for ${texts.length} inputs`);
    }
    if (slots[idx] !== undefined) {
      throw new Error(`OpenRouter embeddings: duplicate index ${idx}`);
    }
    const vec = row.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
      throw new Error(
        `OpenRouter embeddings: vector ${idx} has width ${vec?.length ?? 0}, expected ${EMBEDDING_DIM}`,
      );
    }
    slots[idx] = vec;
  }
  const embeddings = slots.map((vec, i) => {
    if (!vec) throw new Error(`OpenRouter embeddings: missing vector for input ${i}`);
    return vec;
  });
  const promptTokens = parsed.usage?.prompt_tokens ?? 0;
  const attribution = providerModelAttribution(model, parsed.model);
  if (opts.workspaceId) {
    // Best-effort cost logging; never let a logging failure fail the embed.
    await logOpenRouterUsage(
      "embed_posts",
      attribution.model,
      { prompt_tokens: promptTokens, completion_tokens: 0 },
      opts.workspaceId,
      { count: texts.length, ...attribution.metadata },
    ).catch(() => undefined);
  }
  return { embeddings, model: attribution.model, promptTokens };
}

// ---------------------------------------------------------------------------
// Wire types (subset of the OpenAI Chat Completions shape we use)
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// A user message's content can be a plain string OR an array of content blocks
// when files are attached. GLM-5.1 is text-only, so file blocks rely on
// OpenRouter parsing the file to text before the model sees it (see `plugins`
// in streamChat). We use the `file` block (PDF/doc) — images are not supported
// by the text-only model and are rejected upstream in the UI.
export type ContentBlock =
  | {
      type: "text";
      text: string;
      // Prompt-caching breakpoint. MUST sit on a content block (OpenRouter/the
      // Anthropic format ignore it as a top-level message key). Marks the end
      // of the cacheable stable prefix.
      cache_control?: { type: "ephemeral" };
    }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: ChatRole;
  content: string | ContentBlock[] | null;
  // assistant turns may carry tool calls
  tool_calls?: ToolCall[];
  // tool turns answer a specific call
  tool_call_id?: string;
  // Local-only transcript provenance. Attached as a NON-ENUMERABLE property by
  // markPersistedToolState, so it can guide deterministic orchestration without
  // leaking an unknown field into provider request JSON.
  persisted_tool_state?: true;
  // OpenRouter's parsed-file annotation. Echoing this assistant annotation on
  // later rounds lets the provider reuse the first parse instead of parsing
  // the same PDF again.
  annotations?: FileAnnotation[];
};

export type FileAnnotation = {
  type: "file";
  file: {
    hash: string;
    name?: string;
    content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
  };
};

export function markPersistedToolState(message: ChatMessage): ChatMessage {
  Object.defineProperty(message, "persisted_tool_state", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return message;
}

// True if any message carries a `file` content block — used to enable
// OpenRouter's file-parser plugin so the text-only model gets extracted text.
export function hasFileAttachment(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "file"),
  );
}

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  // OpenRouter surfaces cached prompt tokens here when the provider supports it
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_write_5m_tokens?: number;
    cache_write_1h_tokens?: number;
    // Anthropic web_search server-tool requests (billed per request, on top of
    // token pricing — see ANTHROPIC_WEB_SEARCH_FEE_USD).
    web_search_requests?: number;
  };
  // Numeric count only. Cowork never records provider reasoning text.
  completion_tokens_details?: { reasoning_tokens?: number };
};

// Rough token estimate (~4 chars/token) for when the provider's exact usage
// figure is unavailable — e.g. the stream is aborted before the terminal usage
// chunk arrives. Deliberately simple and slightly conservative: it exists so an
// aborted-mid-stream turn still records SOME cost against the cap rather than
// silently logging nothing (the provider already billed for what it generated).
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

// Build an estimated Usage from the raw prompt + streamed output text. Used only
// on the no-exact-usage path; the real usage chunk is always preferred.
export function estimatedUsage(promptText: string, outputText: string): Usage {
  return {
    prompt_tokens: estimateTokens(promptText),
    completion_tokens: estimateTokens(outputText),
  };
}

// Reasoning tier — the chat agent and voice synthesis. Alias of CHAT_MODEL.
export const REASONING_MODEL = CHAT_MODEL;

// Background tier — templatize + hook extraction. Defaults to Luna so the
// former Haiku jobs use the same native OpenAI transport and accounting path.
export const BACKGROUND_MODEL = resolveNativeOpenAIPrimary(
  [process.env.OPENAI_BACKGROUND_MODEL, process.env.OPENROUTER_BACKGROUND_MODEL],
  CHAT_MODEL,
);

// GLM-5.2 reasoning policy. OpenRouter currently defaults this model to High,
// but we send it explicitly so a provider/default change cannot silently alter
// the app's writing behavior. Mechanical callers may opt out; that override is
// intentionally ignored when an env model swap points the call at a non-GLM
// model, avoiding unsupported-parameter failures on the replacement model.
export type GlmReasoning = "high" | "none";

function glmReasoningForModel(
  model: string,
  override: GlmReasoning | undefined,
): { effort: GlmReasoning } | undefined {
  if (model !== "z-ai/glm-5.2") return undefined;
  return { effort: override ?? "high" };
}

// ---------------------------------------------------------------------------
// Non-streaming completion (one-shot)
// ---------------------------------------------------------------------------
//
// For background tasks that want the whole result at once (not a token stream):
// templatize a post, extract a hook, synthesize a voice profile. Supports an
// optional tool + forced tool_choice so a caller can get guaranteed-structured
// output (the voice profile) as a parsed object instead of free-text JSON.

export type CompleteResult = {
  // Assistant text (empty string when the model answered via a tool call).
  text: string;
  // Parsed arguments of the first tool call, if the model made one (used for
  // structured output via forced tool_choice). null when there was no tool call.
  toolArgs: Record<string, unknown> | null;
  finishReason: string | null;
  usage: Usage | undefined;
  // Provider-confirmed model slug. OpenRouter may return a dated/canonical
  // variant of the requested alias, so operational logs must use this value.
  model: string;
  citations: Array<{ url: string; title: string; content: string }>;
};

type RawCompletion = {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { function?: { name?: string; arguments?: string } }[];
      annotations?: Array<{
        type?: string;
        url_citation?: { url?: unknown; title?: unknown; content?: unknown };
      }>;
    };
    finish_reason?: string | null;
  }[];
  usage?: Usage;
};

type RawImageGeneration = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    image_url?: string | { url?: string };
  }>;
  usage?: Usage;
  // Parsed opportunistically, same rationale as RawEmbeddingResponse.model —
  // OpenRouter doesn't consistently document echoing a served-model field on
  // /images. Undefined here just means callers keep using the requested
  // model, exactly as before this field was added.
  model?: string;
};

function imageUrlFromGenerationData(
  first: NonNullable<RawImageGeneration["data"]>[number] | undefined,
): string | null {
  if (!first) return null;
  if (typeof first.url === "string" && first.url) return first.url;
  if (typeof first.image_url === "string" && first.image_url) {
    return first.image_url;
  }
  if (
    first.image_url &&
    typeof first.image_url === "object" &&
    typeof first.image_url.url === "string" &&
    first.image_url.url
  ) {
    return first.image_url.url;
  }
  return null;
}

export async function completeChat(opts: {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  // GLM-only policy override. Omit for explicit High; use "none" only for
  // short mechanical tasks whose output should not compete with reasoning.
  glmReasoning?: GlmReasoning;
  // Explicitly disable reasoning for latency-sensitive calls on any model.
  // This takes precedence over the GLM reasoning policy.
  disableReasoning?: boolean;
  // Provider-agnostic OpenRouter reasoning effort for planners that benefit
  // from bounded judgment without paying for a full reasoning trace.
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  tools?: ToolDef[];
  // Force a specific tool (structured output). Pass the tool's function name.
  forceTool?: string;
  // OpenRouter plugins (e.g. [{ id: "web", max_results: 5 }] for web search).
  plugins?: Array<Record<string, unknown>>;
  // Opt OUT of Anthropic prompt caching for this call.
  //
  // Caching is not free: a cache WRITE costs ~1.25x the input price, and only
  // pays for itself if a later request reads the entry back before the 5-minute
  // TTL. Some paths structurally cannot read — one-shot jobs that run once per
  // user, and reviewer fan-outs whose calls all run concurrently (a cache entry
  // is only readable once the first response starts streaming) and are then
  // idle for hours. Those paid the write premium on every call and collected
  // nothing, which is strictly worse than not caching.
  //
  // Defaults to caching ON, so every existing caller is unchanged.
  cachePrompt?: boolean;
  // Direct-Anthropic only: cache exactly this many leading characters of the
  // already-flattened system prompt. Omitted keeps whole-system caching.
  cacheSystemPrefixChars?: number;
  signal?: AbortSignal;
  // One-shot completions must never inherit the route's full 300s ceiling.
  // Callers with tighter UX budgets (for example image preprocessing) can
  // lower this while still composing with user cancellation.
  timeoutMs?: number;
  // Stable workflow identifier used by OpenRouter for provider-sticky routing.
  sessionId?: string;
}): Promise<CompleteResult> {
  const model = opts.model || BACKGROUND_MODEL;
  {
    const { routesToNativeOpenAI, completeChatOpenAI } = await import("./openai");
    if (routesToNativeOpenAI(model)) return completeChatOpenAI({ ...opts, model });
  }
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1024,
    provider: openRouterProviderPreferences(),
    // Request authoritative provider cost on every one-shot call. This matters
    // for plugin fees and keeps env-selectable models from falling back to a
    // stale local price estimate during non-plugin normalization calls.
    usage: { include: true },
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  };
  const reasoning = opts.disableReasoning
    ? { enabled: false }
    : opts.reasoningEffort
      ? { effort: opts.reasoningEffort }
      : glmReasoningForModel(model, opts.glmReasoning);
  if (reasoning) body.reasoning = reasoning;
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.forceTool
      ? { type: "function", function: { name: opts.forceTool } }
      : "auto";
  }
  if (opts.plugins?.length) {
    body.plugins = opts.plugins;
  }

  const deadline = opts.timeoutMs
    ? AbortSignal.timeout(Math.max(1, opts.timeoutMs))
    : null;
  const signal = deadline
    ? opts.signal
      ? AbortSignal.any([opts.signal, deadline])
      : deadline
    : opts.signal;
  const res = await fetchWithRetry(
    `${OPENROUTER_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal,
    },
    "completeChat",
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new OpenRouterHttpError(res.status, res.statusText);
  }

  const parsed = (await res.json()) as RawCompletion;
  const choice = parsed.choices?.[0];
  const text = choice?.message?.content ?? "";
  let toolArgs: Record<string, unknown> | null = null;
  const rawArgs = choice?.message?.tool_calls?.[0]?.function?.arguments;
  if (rawArgs) {
    try {
      const obj = JSON.parse(rawArgs);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) toolArgs = obj;
    } catch {
      toolArgs = null; // malformed tool args — caller falls back to text
    }
  }
  return {
    text: text ?? "",
    toolArgs,
    finishReason: choice?.finish_reason ?? null,
    usage: parsed.usage,
    model:
      typeof parsed.model === "string" && parsed.model.trim()
        ? parsed.model.trim()
        : model,
    citations: (choice?.message?.annotations ?? [])
      .map((annotation) => annotation.url_citation)
      .filter(
        (citation): citation is { url: string; title?: unknown; content?: unknown } =>
          typeof citation?.url === "string" && citation.url.length > 0,
      )
      .map((citation) => ({
        url: citation.url,
        title: typeof citation.title === "string" ? citation.title : "",
        content: typeof citation.content === "string" ? citation.content : "",
      })),
  };
}

export const IMAGE_GENERATION_MODEL = resolveNativeOpenAIPrimary(
  [process.env.OPENAI_IMAGE_MODEL, process.env.OPENROUTER_IMAGE_MODEL],
  OPENAI_IMAGE_MODEL,
  isOpenAIImageModel,
);

export type ImageGenerationResult = {
  b64Json: string;
  mimeType: string;
  usage: Usage | undefined;
  // The provider-served model, when OpenRouter's response includes one;
  // otherwise the requested model (see RawImageGeneration.model).
  model: string;
};

export async function generateImage(opts: {
  prompt: string;
  referenceDataUrl?: string;
  model?: string;
  aspectRatio?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  signal?: AbortSignal;
}): Promise<ImageGenerationResult> {
  const outputFormat = opts.outputFormat ?? "png";
  const requestedModel = opts.model || IMAGE_GENERATION_MODEL;
  {
    const { routesToNativeOpenAI, generateImageOpenAI } = await import("./openai");
    if (routesToNativeOpenAI(requestedModel)) {
      return generateImageOpenAI({ ...opts, outputFormat, model: requestedModel });
    }
  }
  const body: Record<string, unknown> = {
    model: requestedModel,
    prompt: opts.prompt,
    n: 1,
    output_format: outputFormat,
    resolution: "1K",
  };
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  if (opts.referenceDataUrl) {
    body.input_references = [
      {
        type: "image_url",
        image_url: { url: opts.referenceDataUrl },
      },
    ];
  }

  const res = await fetchWithRetry(
    `${OPENROUTER_BASE_URL}/images`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: opts.signal,
    },
    "generateImage",
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new OpenRouterHttpError(res.status, res.statusText);
  }

  const parsed = (await res.json()) as RawImageGeneration;
  const first = parsed.data?.[0];
  let b64Json = first?.b64_json ?? "";
  const generatedUrl = imageUrlFromGenerationData(first);
  if (!b64Json && generatedUrl) {
    const imageRes = await fetch(generatedUrl, {
      signal: opts.signal,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!imageRes.ok) {
      throw new Error(`OpenRouter image URL could not be downloaded (${imageRes.status}).`);
    }
    const bytes = Buffer.from(await imageRes.arrayBuffer());
    b64Json = bytes.toString("base64");
  }
  if (!b64Json) throw new Error("OpenRouter did not return generated image bytes.");
  return {
    b64Json,
    mimeType: outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`,
    usage: parsed.usage,
    model: providerModelAttribution(requestedModel, parsed.model).model,
  };
}

// ---------------------------------------------------------------------------
// Streaming chat completion
// ---------------------------------------------------------------------------
//
// Yields decoded SSE delta chunks. Callers accumulate text deltas and
// tool_call deltas and dispatch tools as needed. We keep this transport-only:
// no agent logic here.

export type StreamDelta = {
  // incremental assistant text
  text?: string;
  // incremental tool-call fragments (OpenAI streams these by index)
  toolCalls?: {
    index: number;
    id?: string;
    name?: string;
    argumentsFragment?: string;
  }[];
  // why the model stopped this turn, when present on the final chunk
  finishReason?: string | null;
  // usage arrives on the final chunk when stream_options.include_usage is set
  usage?: Usage;
  fileAnnotations?: FileAnnotation[];
  // The provider-served model, present on every chunk per the chat-completions
  // streaming spec (same field completeChat already relies on for its
  // non-streamed responses — see CompleteResult.model).
  model?: string;
};

type RawStreamChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      annotations?: FileAnnotation[];
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Usage;
  model?: string;
  // OpenRouter surfaces mid-stream provider errors (rate limit, upstream 5xx,
  // content filter) as an in-band `data: {"error": {...}}` frame — no choices,
  // no finish_reason. We must NOT swallow it: see parseRecord.
  error?: { message?: string; code?: string | number };
};

export async function* streamChat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  model?: string;
  maxTokens?: number;
  // GLM-only policy override. Ordinary drafts start on High, then may retry
  // with reasoning disabled when the high-reasoning round exceeds the UX
  // budget before producing any visible/dispatchable output.
  glmReasoning?: GlmReasoning;
  signal?: AbortSignal;
  // Override the default tool_choice. "required" forces the model to emit at
  // least one tool call this turn (used on round 0 so the agent can't just
  // narrate intent without calling); "none" forbids tool calls (the
  // forced-final-answer path). Default behavior is unchanged ("auto" when
  // tools are present, undefined when not).
  toolChoice?: "auto" | "required" | "none";
  // Opt OUT of Anthropic prompt caching for this call.
  //
  // Caching is not free: a cache WRITE costs ~1.25x the input price, and only
  // pays for itself if a later request reads the entry back before the 5-minute
  // TTL. Some paths structurally cannot read — one-shot jobs that run once per
  // user, and reviewer fan-outs whose calls all run concurrently (a cache entry
  // is only readable once the first response starts streaming) and are then
  // idle for hours. Those paid the write premium on every call and collected
  // nothing, which is strictly worse than not caching.
  //
  // Defaults to caching ON, so every existing caller is unchanged.
  cachePrompt?: boolean;
  // Stable chat identifier keeps consecutive turns on one provider cache
  // without globally pinning every OpenRouter model.
  sessionId?: string;
}): AsyncGenerator<StreamDelta> {
  const model = opts.model || CHAT_MODEL;
  {
    const { routesToNativeOpenAI, streamChatOpenAI } = await import("./openai");
    if (routesToNativeOpenAI(model)) {
      yield* streamChatOpenAI({ ...opts, model });
      return;
    }
  }
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice:
      opts.toolChoice ??
      (opts.tools && opts.tools.length ? "auto" : undefined),
    stream: true,
    // ask OpenRouter to emit a final usage chunk so we can log cost
    stream_options: { include_usage: true },
    max_tokens: opts.maxTokens ?? 4096,
    provider: openRouterProviderPreferences(),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  };
  // Streamed GLM chat is always substantive agent work. Keep this structurally
  // fixed to High; only one-shot mechanical callers may opt out of reasoning.
  const reasoning = glmReasoningForModel(model, opts.glmReasoning);
  if (reasoning) body.reasoning = reasoning;

  // When a file is attached, enable OpenRouter's file-parser so the text-only
  // model receives extracted text. The pdf-text engine handles text-based PDFs
  // cheaply; OpenRouter falls back to OCR for scanned ones.
  if (hasFileAttachment(opts.messages)) {
    body.plugins = [{ id: "file-parser", pdf: { engine: "pdf-text" } }];
  }

  // Combine the caller's signal (Stop button / disconnect) with an overall
  // connection deadline, so a connection that opens then never finishes is
  // bailed cleanly under the 300s function ceiling rather than hard-killed.
  // AbortSignal.any aborts when EITHER fires; the deadline is a TimeoutError
  // (isAbortError → not retried). The retry wraps ONLY this fetch (the connect
  // phase) — never the read loop below, so streamed text is never replayed.
  const deadline = AbortSignal.timeout(STREAM_DEADLINE_MS);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, deadline])
    : deadline;
  const res = await fetchWithRetry(
    `${OPENROUTER_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: combinedSignal,
    },
    "streamChat",
  );

  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new OpenRouterHttpError(res.status, res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Parse one complete SSE record (the text between record separators). A record
  // may carry multiple lines; we only act on `data:` lines. Returns a StreamDelta
  // to yield, "done" for the [DONE] sentinel, or null for comments/keepalives.
  // CRITICAL: we never act on an incomplete record — records are only split off
  // the buffer once a full separator is seen, so a frame fragmented across TCP
  // reads is reassembled instead of being parsed half-formed and dropped.
  const parseRecord = (record: string): StreamDelta | "done" | null => {
    // Concatenate all `data:` lines in the record (SSE allows multi-line data).
    let data = "";
    for (const raw of record.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith(":")) continue; // comment/keepalive
      if (line.startsWith("data:")) data += line.slice(5).trimStart();
    }
    data = data.trim();
    if (!data) return null;
    if (data === "[DONE]") return "done";

    let parsed: RawStreamChunk;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null; // malformed complete record — skip it, don't kill the stream
    }

    // In-band provider error (OpenRouter sends these mid-stream as a frame with
    // an `error` and no choices). Throwing here surfaces it: the agent loop's
    // catch turns it into an {type:'error'} event → SSE error frame → toast.
    // Without this the frame parses to null and the stream just ends silently,
    // leaving the turn looking frozen (only whatever text preceded it shows).
    if (parsed.error) {
      // Attach the provider error code/type to the thrown error so the agent
      // loop's catch can include it in the SSE error event. OpenRouter uses
      // `code` (sometimes numeric HTTP-status-like, sometimes string), which
      // distinguishes e.g. rate_limit_exceeded from invalid_request.
      const err = new Error(parsed.error.message || "The model stream errored.");
      (err as Error & { code?: string | number }).code = parsed.error.code;
      throw err;
    }

    const choice = parsed.choices?.[0];
    const delta: StreamDelta = {};
    if (choice?.delta?.content) delta.text = choice.delta.content;
    if (choice?.delta?.tool_calls) {
      delta.toolCalls = choice.delta.tool_calls.map((tc) => ({
        index: tc.index,
        id: tc.id,
        name: tc.function?.name,
        argumentsFragment: tc.function?.arguments,
      }));
    }
    if (choice?.delta?.annotations?.length) {
      delta.fileAnnotations = choice.delta.annotations.filter(
        (annotation) =>
          annotation?.type === "file" &&
          typeof annotation.file?.hash === "string" &&
          Array.isArray(annotation.file.content),
      );
    }
    if (choice?.finish_reason !== undefined) {
      delta.finishReason = choice.finish_reason;
    }
    if (parsed.usage) delta.usage = parsed.usage;

    if (
      delta.text !== undefined ||
      delta.toolCalls !== undefined ||
      delta.finishReason !== undefined ||
      delta.usage !== undefined ||
      delta.fileAnnotations !== undefined
    ) {
      // Only stamp `model` onto a delta that's ALREADY yield-worthy for
      // another reason — a model-only chunk (typically the very first SSE
      // frame, before any content) must stay a silent no-op exactly as
      // before this field existed, so this never changes the stream's shape
      // or introduces an extra yielded delta downstream.
      if (typeof parsed.model === "string" && parsed.model.trim()) {
        delta.model = parsed.model.trim();
      }
      return delta;
    }
    return null;
  };

  // Race a reader.read() against an idle timer. If no chunk arrives within
  // STREAM_IDLE_TIMEOUT_MS the stream has stalled — cancel the reader (so the
  // socket frees and the generator's finally can run) and throw a typed error
  // the agent loop surfaces as a real "the model stalled" message instead of a
  // frozen turn. The timer is RESET on every read (it returns), so a steadily-
  // streaming generation never trips it. The deadline abort above also lands
  // here: a read on an aborted body rejects, which we let propagate.
  const readWithIdleTimeout = async (): Promise<
    ReadableStreamReadResult<Uint8Array>
  > => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error("The model stream stalled (no data).");
        (err as Error & { code?: string }).code = "stream_stalled";
        reject(err);
      }, STREAM_IDLE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([reader.read(), idle]);
    } catch (e) {
      // On a stall, cancel the reader so the underlying connection is released.
      await reader.cancel().catch(() => undefined);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  while (true) {
    const { done, value } = await readWithIdleTimeout();
    if (done) {
      // Flush: decode any trailing multibyte bytes, then process whatever
      // remains in the buffer as a final record (the last frame may arrive
      // without a trailing separator).
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) {
        const out = parseRecord(tail);
        if (out && out !== "done") yield out;
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    // SSE records are separated by a blank line (\n\n). Process every COMPLETE
    // record and keep the trailing partial in the buffer for the next read.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const record = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const out = parseRecord(record);
      if (out === "done") return;
      if (out) yield out;
    }
  }
}

// ---------------------------------------------------------------------------
// Usage logging — parallels lib/usage.ts:logAnthropicUsage, with GLM pricing
// and a workspace_id (added in migration 036) so chat spend is attributable.
// ---------------------------------------------------------------------------

// USD per million tokens. Update if OpenRouter/Z.ai changes rates.
// cacheWrite is the 1-hour-TTL rate; cacheWrite5m is the 5-minute rate.
// Anthropic reports the two TTL buckets separately and openRouterUsageCost
// preserves that split so mixed system/tool breakpoints bill exactly.
export const NEWS_SEARCH_MODEL_PRICING = {
  "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cachedInput: 0.025 },
  // Historical rows remain priced for cost-dashboard accuracy, but are
  // excluded from SUPPORTED_NEWS_MODELS below and cannot be selected for new
  // discovery calls.
  "anthropic/claude-haiku-4.5": {
    input: 1.0,
    output: 5.0,
    cachedInput: 0.1,
    cacheWrite: 2.0,
    cacheWrite5m: 1.25,
  },
  "anthropic/claude-sonnet-5": {
    input: 2.0,
    output: 10.0,
    cachedInput: 0.2,
    cacheWrite: 4.0,
    cacheWrite5m: 2.5,
  },
  "openai/gpt-5.6-luna": {
    input: 1.0,
    output: 6.0,
    cachedInput: 0.1,
    cacheWrite: 1.25,
  },
  "z-ai/glm-5.2": { input: 0.93, output: 3.0, cachedInput: 0.18 },
} as const;

export const SUPPORTED_NEWS_MODELS = Object.keys(NEWS_SEARCH_MODEL_PRICING).filter(
  (model) => !model.startsWith("anthropic/"),
);

const OPENROUTER_PRICING: Record<
  string,
  {
    input: number;
    output: number;
    cachedInput: number;
    cacheWrite?: number;
    cacheWrite5m?: number;
  }
> = {
  ...NEWS_SEARCH_MODEL_PRICING,
  "qwen/qwen3.7-plus": { input: 0.32, output: 1.28, cachedInput: 0.064 },
  "z-ai/glm-5.1": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "z-ai/glm-5": { input: 1.0, output: 3.2, cachedInput: 0.2 },
  // Retained for historical usage rows and explicit env overrides.
  "anthropic/claude-sonnet-4.6": {
    input: 3.0,
    output: 15.0,
    cachedInput: 0.3,
    cacheWrite: 6.0,
    cacheWrite5m: 3.75,
  },
  // Sonnet 5 is used as a fallback by the thin writer and orchestrators.
  // Without this entry openRouterCost would fall back to the GLM-5.1 rate and
  // under-count spend, so the monthly cost cap would be wrong. Sonnet 5 is
  // currently $2 in / $10 out; cache-read is 0.1x input = $0.20, cache-write
  // (1h TTL) is 2x input = $4.00. (This literal overrides the spread
  // NEWS_SEARCH_MODEL_PRICING row — keep them identical.)
  "anthropic/claude-sonnet-5": {
    input: 2.0,
    output: 10.0,
    cachedInput: 0.2,
    cacheWrite: 4.0,
    cacheWrite5m: 2.5,
  },
  // Bare slug is what the Anthropic adapter sends (AI_PROVIDER=anthropic). The
  // adapter leaves usage.cost unset, so this table computes cost from tokens.
  // Sonnet 5 intro pricing: $2/M in, $10/M out; cache-read 0.1x input = $0.20,
  // cache-write 1h TTL 2x input = $4.00; 5m is 1.25x = $2.50. (Standard rates after the intro
  // window are $3/$15 — bump these lines when the intro ends 2026-08-31.)
  "claude-sonnet-5": {
    input: 2.0,
    output: 10.0,
    cachedInput: 0.2,
    cacheWrite: 4.0,
    cacheWrite5m: 2.5,
  },
  // Cross-provider fallback for the read-only Cowork orchestrator. OpenRouter's
  // model catalog lists $1.50/M input, $9/M output, and $0.15/M cache reads.
  // Keep the local fallback accurate for rare responses without usage.cost.
  "google/gemini-3.5-flash": { input: 1.5, output: 9.0, cachedInput: 0.15 },
  // A supported OPENROUTER_CHAT_MODEL choice. OpenRouter lists $1.50/M input,
  // $7.50/M output; cache reads aren't published, so use Gemini's standard
  // 0.1x-input convention ($0.15) to match gemini-3.5-flash above. Without this
  // entry an unpriced slug falls back to the GLM-5.1 rate ($4.40/M out) and
  // under-counts the monthly cost cap on the rare responses lacking usage.cost
  // (aborted/stalled streams, providers that omit cost). usage.cost is still
  // preferred whenever present (see openRouterUsageCost).
  "google/gemini-3.6-flash": { input: 1.5, output: 7.5, cachedInput: 0.15 },
  // Embedding model for the viral-learning loop. text-embedding-3-small is
  // $0.02/1M input; embeddings have no output tokens and no cache-read tier, so
  // output/cachedInput mirror input to keep the cost math well-defined.
  "openai/text-embedding-3-small": { input: 0.02, output: 0.02, cachedInput: 0.02 },
};

// The pricing table is keyed by OpenRouter slugs (`anthropic/claude-...`), but
// under AI_PROVIDER=anthropic the adapter returns Anthropic's API id
// (`claude-haiku-4-5-20251001`), which then flows into cost lookup via the
// served model. Map a bare Claude id back to its `anthropic/`-prefixed pricing
// key so every bare Claude model (current and future) prices correctly instead
// of silently falling back to the GLM-5.1 rate and mis-counting the monthly
// cost cap. Bare `claude-sonnet-5` keeps its own explicit row; this only kicks
// in when the exact key is absent.
function pricingKey(model: string): string {
  if (Object.hasOwn(OPENROUTER_PRICING, model)) return model;
  if (/^claude-/i.test(model)) {
    const prefixed = `anthropic/${model}`;
    if (Object.hasOwn(OPENROUTER_PRICING, prefixed)) return prefixed;
    // Anthropic API ids dash the minor version and may carry a date suffix
    // (`claude-haiku-4-5-20251001`); OpenRouter pricing keys dot it
    // (`anthropic/claude-haiku-4.5`). Normalize so adapter-served ids price at
    // their true rate instead of falling back to the GLM-5.1 default.
    const m = model.match(/^(claude-[a-z]+-\d+)-(\d+?)(?:-\d{8})?$/i);
    if (m) {
      const dotted = `anthropic/${m[1]}.${m[2]}`;
      if (Object.hasOwn(OPENROUTER_PRICING, dotted)) return dotted;
    }
  }
  return model;
}

export function hasOpenRouterPricing(model: string): boolean {
  return Object.hasOwn(OPENROUTER_PRICING, pricingKey(model));
}

export function openRouterCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  cacheWriteTokens = 0,
  cacheWrite5mTokens = 0,
): number {
  const p =
    OPENROUTER_PRICING[pricingKey(model)] ?? OPENROUTER_PRICING["z-ai/glm-5.1"];
  const boundedCached = Math.min(Math.max(0, cachedInputTokens), inputTokens);
  const boundedCacheWrite = Math.min(
    Math.max(0, cacheWriteTokens),
    Math.max(0, inputTokens - boundedCached),
  );
  const boundedCacheWrite5m = Math.min(
    Math.max(0, cacheWrite5mTokens),
    boundedCacheWrite,
  );
  const boundedCacheWrite1h = boundedCacheWrite - boundedCacheWrite5m;
  const freshInput = Math.max(
    0,
    inputTokens - boundedCached - boundedCacheWrite,
  );
  return (
    (freshInput * p.input +
      boundedCached * p.cachedInput +
      boundedCacheWrite5m * (p.cacheWrite5m ?? p.cacheWrite ?? p.input) +
      boundedCacheWrite1h * (p.cacheWrite ?? p.input) +
      outputTokens * p.output) /
    1_000_000
  );
}

// Anthropic's web_search server tool: $10 per 1,000 requests, billed on top of
// token pricing. The OpenRouter web plugin bundled its fee into usage.cost, so
// searches on the Anthropic path need this added explicitly or every grounded
// search is free on the ledger.
export const ANTHROPIC_WEB_SEARCH_FEE_USD = 0.01;

export function openRouterUsageCost(
  model: string,
  usage: Usage | undefined,
): {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
} {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens =
    usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const cacheWrite5mTokens =
    usage?.prompt_tokens_details?.cache_write_5m_tokens ?? 0;
  const reasoningTokens =
    usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const webSearchRequests =
    usage?.prompt_tokens_details?.web_search_requests ?? 0;
  const exactCost = typeof usage?.cost === "number" && Number.isFinite(usage.cost)
    ? usage.cost
    : null;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheWriteTokens,
    costUsd:
      (exactCost ??
        openRouterCost(
          model,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteTokens,
          cacheWrite5mTokens,
        )) +
      // Anthropic's web_search server tool bills per REQUEST on top of token
      // pricing; the OpenRouter web plugin bundled its fee into usage.cost, so
      // a news search on the Anthropic path was previously unbilled entirely.
      webSearchRequests * ANTHROPIC_WEB_SEARCH_FEE_USD,
  };
}

export async function logOpenRouterUsage(
  kind: string,
  model: string,
  usage: Usage | undefined,
  workspaceId: string,
  meta?: Record<string, unknown>,
): Promise<void> {  const {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    costUsd,
  } = openRouterUsageCost(model, usage);
  const { routesToNativeOpenAI } = await import("./openai");
  const provider = routesToNativeOpenAI(model) ? "openai" : "openrouter";
  try {
    const sb = supabaseAdmin();
    const { error } = await sb.from("usage_events").insert({
      provider,
      kind,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      workspace_id: workspaceId,
      meta: {
        ...(meta ?? {}),
        cached_input_tokens: cached,
        cache_write_tokens: cacheWrite,
        cache_write_5m_tokens:
          usage?.prompt_tokens_details?.cache_write_5m_tokens ?? 0,
        cache_write_1h_tokens:
          usage?.prompt_tokens_details?.cache_write_1h_tokens ??
          Math.max(
            0,
            cacheWrite -
              (usage?.prompt_tokens_details?.cache_write_5m_tokens ?? 0),
          ),
        reasoning_tokens: reasoningTokens,
      },
    });
    if (error) throw error;
  } catch (e) {
    // A dropped usage insert SILENTLY under-counts the monthly cost cap forever
    // — the whole reason this call is awaited is to guarantee the spend is
    // recorded before the turn releases. A bare console.error wasn't grep-able
    // and carried no workspace/token context, so the leak was invisible. Emit a
    // structured `usage_log_drop` metric instead (grep `usage_log_drop` to count
    // the failure rate per workspace). We deliberately do NOT retry: a retry
    // that partially succeeds would double-insert and OVER-count; a safe retry
    // needs an idempotency key, which the table doesn't have today.
    console.error("openrouter usage log fail", (e as Error).message);
    console.log(
      JSON.stringify({
        usage_log_drop: {
          workspace_id: workspaceId,
          kind,
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          error: (e as Error).message,
        },
      }),
    );
    await holdWorkspaceCostClaims(workspaceId).catch((holdError) => {
      console.error("workspace cost claim hold fail", (holdError as Error).message);
    });
    throw new UsagePersistenceError((e as Error).message);
  }
}

export class UsagePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsagePersistenceError";
  }
}
