import { supabaseAdmin } from "./supabase";

// ---------------------------------------------------------------------------
// OpenRouter client (OpenAI-compatible Chat Completions)
// ---------------------------------------------------------------------------
//
// The chat workspace runs on GLM-5.1 via OpenRouter. OpenRouter's API is
// OpenAI-compatible, so we talk to it with raw fetch against the Chat
// Completions endpoint rather than pulling in the `openai` SDK — keeps the
// dependency surface small and gives us direct control over SSE parsing for
// the streaming tool-calling loop.
//
// Model is a single config constant so swapping GLM-5.1 <-> GLM-5 (or A/B'ing
// them) is a one-line change, per the cost analysis we did up front.

// Two tiers, both on OpenRouter:
//
// REASONING (GLM-5.2, $1.20/M in, $4.10/M out): the chat agent + voice
// synthesis — anything that reasons, drafts, or matches a creator's voice. We
// trialled Claude Sonnet 5 here for stronger instruction-following, but at
// ~5-8x GLM's output cost it was not worth it for the chat tier; the
// judgment-heavy part (whether to ASK vs proceed) already runs on Sonnet 4.6
// in the decision pre-pass (see decide.ts), which is where reliability matters
// most. The $15/user monthly budget cap still applies (see rate-limit.ts).
//
// BACKGROUND (GLM-5.1): the mechanical/categorizing tasks — templatize a post
// (structure-preserving fill-in-the-blank) and extract a hook (excerpt + pick a
// pattern tag). They don't need frontier reasoning, so they stay on the cheap
// GLM tier (see BACKGROUND_MODEL below).
//
// Each is env-overridable for A/B or pinning (OPENROUTER_CHAT_MODEL etc.).
export const CHAT_MODEL =
  process.env.OPENROUTER_CHAT_MODEL || "z-ai/glm-5.2";

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
      await sleep(delay);
      lastErr = new Error(`OpenRouter ${res.status} ${res.statusText}`);
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
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenRouter request failed");
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
};

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
  prompt_tokens_details?: { cached_tokens?: number };
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

// Background tier — templatize + hook extraction. Defaults to GLM-5.2 as well
// (5.2 is both cheaper and stronger than 5.1, so there's no reason to keep the
// mechanical tasks on the older model). Kept as a separate env knob in case you
// ever want to point the cheap, high-volume tasks at a smaller/cheaper model.
export const BACKGROUND_MODEL =
  process.env.OPENROUTER_BACKGROUND_MODEL || CHAT_MODEL;

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
};

type RawCompletion = {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { function?: { name?: string; arguments?: string } }[];
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
  tools?: ToolDef[];
  // Force a specific tool (structured output). Pass the tool's function name.
  forceTool?: string;
  signal?: AbortSignal;
}): Promise<CompleteResult> {
  const body: Record<string, unknown> = {
    model: opts.model || BACKGROUND_MODEL,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1024,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.forceTool
      ? { type: "function", function: { name: opts.forceTool } }
      : "auto";
  }

  const res = await fetchWithRetry(
    `${OPENROUTER_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: opts.signal,
    },
    "completeChat",
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    );
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
  };
}

export const IMAGE_GENERATION_MODEL =
  process.env.OPENROUTER_IMAGE_MODEL || "google/gemini-3-pro-image";

export type ImageGenerationResult = {
  b64Json: string;
  mimeType: string;
  usage: Usage | undefined;
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
  const body: Record<string, unknown> = {
    model: opts.model || IMAGE_GENERATION_MODEL,
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
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    );
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
  };
}

// ---------------------------------------------------------------------------
// Streaming chat completion
// ---------------------------------------------------------------------------
//
// Yields decoded SSE delta chunks. The caller (lib/agent/run.ts) accumulates
// text deltas and tool_call deltas, decides whether to dispatch tools, and
// loops. We keep this transport-only: no agent logic here.

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
};

type RawStreamChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Usage;
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
  signal?: AbortSignal;
  // Override the default tool_choice. "required" forces the model to emit at
  // least one tool call this turn (used on round 0 so the agent can't just
  // narrate intent without calling); "none" forbids tool calls (the
  // forced-final-answer path). Default behavior is unchanged ("auto" when
  // tools are present, undefined when not).
  toolChoice?: "auto" | "required" | "none";
}): AsyncGenerator<StreamDelta> {
  const body: Record<string, unknown> = {
    model: opts.model || CHAT_MODEL,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice:
      opts.toolChoice ??
      (opts.tools && opts.tools.length ? "auto" : undefined),
    stream: true,
    // ask OpenRouter to emit a final usage chunk so we can log cost
    stream_options: { include_usage: true },
    max_tokens: opts.maxTokens ?? 4096,
  };

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
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    );
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
    if (choice?.finish_reason !== undefined) {
      delta.finishReason = choice.finish_reason;
    }
    if (parsed.usage) delta.usage = parsed.usage;

    if (
      delta.text !== undefined ||
      delta.toolCalls !== undefined ||
      delta.finishReason !== undefined ||
      delta.usage !== undefined
    ) {
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
const OPENROUTER_PRICING: Record<
  string,
  { input: number; output: number; cachedInput: number }
> = {
  "z-ai/glm-5.2": { input: 1.2, output: 4.1, cachedInput: 0.22 },
  "z-ai/glm-5.1": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "z-ai/glm-5": { input: 1.0, output: 3.2, cachedInput: 0.2 },
  // The decision pre-pass (lib/agent/decide.ts) runs on Sonnet 4.6 via
  // OpenRouter. Without this entry openRouterCost fell back to the GLM-5.1 rate
  // ($1.4/$4.4) and UNDER-counted decision spend ~3x, so the monthly cost cap
  // undercounted it. Sonnet 4.6 is $3 in / $15 out; cache-read is Anthropic's
  // standard 0.1x input = $0.30 (the decision call sends a fresh prompt with no
  // cache breakpoint, so cached tokens are ~0 in practice — set for correctness).
  "anthropic/claude-sonnet-4.6": { input: 3.0, output: 15.0, cachedInput: 0.3 },
  // Sonnet 5 — NOT the live chat model (we reverted CHAT_MODEL to GLM-5.2 on
  // cost). Kept priced so a manual OPENROUTER_CHAT_MODEL=anthropic/claude-sonnet-5
  // A/B still bills correctly instead of hitting the GLM fallback. INTRODUCTORY
  // $2 in / $10 out through 2026-08-31, then the standard $3 / $15. ⚠️ If this
  // ever becomes CHAT_MODEL again on/after 2026-09-01, update to { input: 3.0,
  // output: 15.0, cachedInput: 0.3 }. Cache-read is Anthropic's standard 0.1x
  // input ($0.20 intro).
  "anthropic/claude-sonnet-5": { input: 2.0, output: 10.0, cachedInput: 0.2 },
};

export function openRouterCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const p = OPENROUTER_PRICING[model] ?? OPENROUTER_PRICING["z-ai/glm-5.1"];
  // cached tokens are billed at the cheaper cache-read rate; the rest at full
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (freshInput * p.input +
      cachedInputTokens * p.cachedInput +
      outputTokens * p.output) /
    1_000_000
  );
}

export function openRouterUsageCost(
  model: string,
  usage: Usage | undefined,
): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
} {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const exactCost = typeof usage?.cost === "number" && Number.isFinite(usage.cost)
    ? usage.cost
    : null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd: exactCost ?? openRouterCost(model, inputTokens, outputTokens, cachedInputTokens),
  };
}

export async function logOpenRouterUsage(
  kind: string,
  model: string,
  usage: Usage | undefined,
  workspaceId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const {
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    costUsd,
  } = openRouterUsageCost(model, usage);
  try {
    const sb = supabaseAdmin();
    await sb.from("usage_events").insert({
      provider: "openrouter",
      kind,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      workspace_id: workspaceId,
      meta: { cached_input_tokens: cached, ...(meta ?? {}) },
    });
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
  }
}
