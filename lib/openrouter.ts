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

// Two tiers, both on OpenRouter (text-only GLM):
//
// REASONING (GLM-5.2, $1.20/M in, $4.10/M out, 1M context): the chat agent and
// voice synthesis — anything that reasons, drafts, or matches a creator's
// voice. 5.2 is meaningfully stronger on these and actually cheaper than 5.1.
//
// BACKGROUND (GLM-5.1): the mechanical/categorizing tasks — templatize a post
// (structure-preserving fill-in-the-blank) and extract a hook (excerpt + pick a
// pattern tag). They don't need 5.2's reasoning, so they stay on the cheaper-
// enough 5.1.
//
// Each is env-overridable for A/B or pinning.
export const CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL || "z-ai/glm-5.2";

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
  | { type: "file"; file: { filename: string; file_data: string } };

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
  // OpenRouter surfaces cached prompt tokens here when the provider supports it
  prompt_tokens_details?: { cached_tokens?: number };
};

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

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
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
}): AsyncGenerator<StreamDelta> {
  const body: Record<string, unknown> = {
    model: opts.model || CHAT_MODEL,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: opts.tools && opts.tools.length ? "auto" : undefined,
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

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

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
      throw new Error(parsed.error.message || "The model stream errored.");
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

  while (true) {
    const { done, value } = await reader.read();
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

export async function logOpenRouterUsage(
  kind: string,
  model: string,
  usage: Usage | undefined,
  workspaceId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const cost = openRouterCost(model, inputTokens, outputTokens, cached);
    const sb = supabaseAdmin();
    await sb.from("usage_events").insert({
      provider: "openrouter",
      kind,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
      workspace_id: workspaceId,
      meta: { cached_input_tokens: cached, ...(meta ?? {}) },
    });
  } catch (e) {
    console.error("openrouter usage log fail", (e as Error).message);
  }
}
