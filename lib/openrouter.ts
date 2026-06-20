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

// z-ai/glm-5.1: $1.40/M in, $4.40/M out, $0.26/M cache-read, 200K context,
// tool-calling + streaming + structured outputs. Swap to "z-ai/glm-5" to pin
// the cheaper-output variant, or read from env to A/B at runtime.
export const CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL || "z-ai/glm-5.1";

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

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  // assistant turns may carry tool calls
  tool_calls?: ToolCall[];
  // tool turns answer a specific call
  tool_call_id?: string;
  // optional cache_control marker (Anthropic-style; OpenRouter passes through
  // to providers that support prompt caching, incl. some GLM endpoints).
  // Applied to the last stable-prefix message so the system + tool context is
  // cached and re-read cheaply across turns.
  cache_control?: { type: "ephemeral" };
};

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
};

export async function* streamChat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): AsyncGenerator<StreamDelta> {
  const body = {
    model: opts.model || CHAT_MODEL,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: opts.tools && opts.tools.length ? "auto" : undefined,
    stream: true,
    // ask OpenRouter to emit a final usage chunk so we can log cost
    stream_options: { include_usage: true },
    max_tokens: opts.maxTokens ?? 4096,
  };

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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by double newlines; lines start with "data: ".
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(":")) continue; // comment/keepalive
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;

      let parsed: RawStreamChunk;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // partial frame; the next read will complete it
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
        yield delta;
      }
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
