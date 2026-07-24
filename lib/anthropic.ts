import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ContentBlock,
  CompleteResult,
  StreamDelta,
  ToolCall,
  ToolDef,
  Usage,
} from "./openrouter";

// ---------------------------------------------------------------------------
// Anthropic adapter — a drop-in provider for the app's ONE text seam.
// ---------------------------------------------------------------------------
//
// The whole app funnels text/agent/writer/gate work through completeChat /
// streamChat in lib/openrouter.ts, all defaulting to one model
// (OPENROUTER_CHAT_MODEL). This module re-implements the *public surface* of
// those two functions against the Anthropic Messages API so a single flag
// (AI_PROVIDER=anthropic) moves the entire text surface onto one bill — and, the
// concrete driver, runs the workspace custom skills on the same account. It is
// intentionally shape-faithful: it returns the exact CompleteResult /
// StreamDelta the OpenRouter path returns, so no downstream caller, no persisted
// tool_calls / usage_events row, and none of the output-text nets change.
//
// What does NOT route here: embeddings and image generation stay on OpenRouter
// (Anthropic has no such API). Those paths in openrouter.ts are untouched.
//
// Key transport differences bridged below:
//   1. `system` is a top-level field on Anthropic, not a role:"system" message.
//      We hoist every system message out of `messages` into `system`.
//   2. Tool calls: OpenAI `tool_calls[].function.arguments` (JSON string) vs.
//      Anthropic `tool_use` blocks (`input` already an object). completeChat
//      collapses to a single parsed `toolArgs`; when we build assistant history
//      we emit the OpenAI-shaped ToolCall so hydration of stored chats stays
//      valid.
//   3. Reasoning: Sonnet rejects temperature/top_p and budget_tokens. We map the
//      app's reasoning knobs to output_config.effort + adaptive/disabled
//      thinking. Never send sampling params.

const ANTHROPIC_CHAT_MODEL =
  process.env.ANTHROPIC_CHAT_MODEL || "claude-sonnet-5";

// Watchdog parity with streamChat. Same env knobs and defaults so ops can tune
// both providers with one set of variables.
const STREAM_IDLE_TIMEOUT_MS = Number(
  process.env.OPENROUTER_STREAM_IDLE_MS || 45_000,
);
const STREAM_DEADLINE_MS = Number(
  process.env.OPENROUTER_STREAM_DEADLINE_MS || 290_000,
);

// True when the resolved model should be served by Anthropic. The flag gates
// the whole thing; the claude-* check is a guard so a stray non-Claude model
// override never gets sent to the Anthropic endpoint.
export function useAnthropic(model: string): boolean {
  return (
    process.env.AI_PROVIDER === "anthropic" && model.startsWith("claude-")
  );
}

// The resolved default text model when the flag is on. openrouter.ts consults
// this so CHAT_MODEL / REASONING_MODEL / BACKGROUND_MODEL all move together.
export function anthropicChatModel(): string {
  return ANTHROPIC_CHAT_MODEL;
}

let cached: Anthropic | null = null;
function client(): Anthropic {
  if (!cached) {
    cached = new Anthropic({
      apiKey:
        process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY,
    });
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Message translation (OpenAI-shaped ChatMessage[] -> Anthropic request)
// ---------------------------------------------------------------------------

type AnthropicMessage = {
  role: "user" | "assistant";
  content: Anthropic.ContentBlockParam[];
};

function toAnthropicContent(
  content: string | ContentBlock[] | null,
): Anthropic.ContentBlockParam[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  const out: Anthropic.ContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const b: Anthropic.TextBlockParam = { type: "text", text: block.text };
      if (block.cache_control) b.cache_control = { type: "ephemeral" };
      out.push(b);
    } else if (block.type === "image_url") {
      // Vision. Anthropic takes a url or base64 source; the app passes data or
      // https URLs as `url`.
      out.push({
        type: "image",
        source: { type: "url", url: block.image_url.url },
      });
    } else if (block.type === "file") {
      // OpenRouter parsed PDFs to text via a plugin; Anthropic reads PDFs as a
      // document block. file_data is a base64 data URL or raw base64.
      const data = block.file.file_data.replace(
        /^data:application\/pdf;base64,/,
        "",
      );
      out.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data },
      });
    }
  }
  return out;
}

// Split the OpenAI-shaped transcript into Anthropic's (system, messages).
// - role:"system" messages are concatenated into the top-level system string.
// - role:"tool" (+ tool_call_id) becomes a user tool_result block.
// - assistant tool_calls become tool_use blocks.
export function translateMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === "text") systemParts.push(b.text);
      }
      continue;
    }

    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content:
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content ?? ""),
          },
        ],
      });
      continue;
    }

    if (m.role === "assistant") {
      const content = toAnthropicContent(m.content);
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: input as Record<string, unknown>,
          });
        }
      }
      out.push({ role: "assistant", content });
      continue;
    }

    // role:"user"
    out.push({ role: "user", content: toAnthropicContent(m.content) });
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function toAnthropicTools(tools: ToolDef[]): Anthropic.ToolUnion[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }));
}

// The app's reasoning knobs -> Anthropic effort. Sonnet has adaptive thinking on
// by default; disableReasoning turns it off. We never send temperature/top_p.
type Effort = "low" | "medium" | "high";
export function effortFor(opts: {
  disableReasoning?: boolean;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}): { effort: Effort; thinkingOff: boolean } {
  if (opts.disableReasoning) return { effort: "low", thinkingOff: true };
  switch (opts.reasoningEffort) {
    case "minimal":
    case "low":
      return { effort: "low", thinkingOff: false };
    case "medium":
      return { effort: "medium", thinkingOff: false };
    default:
      return { effort: "high", thinkingOff: false };
  }
}

export function mapUsage(u: Anthropic.Usage | undefined): Usage | undefined {
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    prompt_tokens_details: {
      cached_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const deadline = timeoutMs
    ? AbortSignal.timeout(Math.max(1, timeoutMs))
    : null;
  if (deadline && signal) return AbortSignal.any([signal, deadline]);
  return deadline ?? signal;
}

// ---------------------------------------------------------------------------
// Non-streaming completion — mirrors completeChat -> CompleteResult
// ---------------------------------------------------------------------------

export async function completeChatAnthropic(opts: {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  glmReasoning?: "high" | "none";
  disableReasoning?: boolean;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  tools?: ToolDef[];
  forceTool?: string;
  plugins?: Array<Record<string, unknown>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  sessionId?: string;
}): Promise<CompleteResult> {
  const model = opts.model || anthropicChatModel();
  const { system, messages } = translateMessages(opts.messages);
  const { effort, thinkingOff } = effortFor(opts);
  // Give Sonnet headroom: heavier tokenizer + thinking. Floor at 2048 even when
  // a legacy caller passes the old 1024 default.
  const maxTokens = Math.max(opts.maxTokens ?? 2048, 2048);

  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages,
    thinking: thinkingOff
      ? { type: "disabled" }
      : { type: "adaptive" },
    output_config: { effort },
  };
  if (system) body.system = system;
  if (opts.tools?.length) {
    body.tools = toAnthropicTools(opts.tools);
    body.tool_choice = opts.forceTool
      ? { type: "tool", name: opts.forceTool }
      : { type: "auto" };
  }

  const signal = combineSignals(opts.signal, opts.timeoutMs);
  // Stream internally for large budgets so we never hit an HTTP timeout, then
  // return the accumulated final message shaped as CompleteResult.
  const response = await client()
    .messages.stream(body, { signal })
    .finalMessage();

  let text = "";
  let toolArgs: Record<string, unknown> | null = null;
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use" && toolArgs === null) {
      toolArgs =
        block.input && typeof block.input === "object" && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : null;
    }
  }

  return {
    text,
    toolArgs,
    finishReason: response.stop_reason ?? null,
    usage: mapUsage(response.usage),
    model: response.model || model,
    citations: [],
  };
}

// ---------------------------------------------------------------------------
// Streaming completion — mirrors streamChat -> AsyncGenerator<StreamDelta>.
// Text-only: the two callers (executeAnswerTurn, /api/rewrite) consume only
// text/usage/model. Tool-call streaming is defined in StreamDelta but unused.
// ---------------------------------------------------------------------------

export async function* streamChatAnthropic(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  model?: string;
  maxTokens?: number;
  glmReasoning?: "high" | "none";
  signal?: AbortSignal;
  toolChoice?: "auto" | "required" | "none";
  sessionId?: string;
}): AsyncGenerator<StreamDelta> {
  const model = opts.model || anthropicChatModel();
  const { system, messages } = translateMessages(opts.messages);
  const maxTokens = Math.max(opts.maxTokens ?? 4096, 2048);

  const body: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  };
  if (system) body.system = system;
  if (opts.tools?.length && opts.toolChoice !== "none") {
    body.tools = toAnthropicTools(opts.tools);
  }

  // Overall connection deadline + caller signal, aborting either fires. The
  // idle watchdog below is separate: it cancels a stream that opens but goes
  // silent, mirroring streamChat's per-read timeout.
  const deadline = AbortSignal.timeout(STREAM_DEADLINE_MS);
  const controller = new AbortController();
  const combined = opts.signal
    ? AbortSignal.any([opts.signal, deadline, controller.signal])
    : AbortSignal.any([deadline, controller.signal]);

  const stream = client().messages.stream(body, { signal: combined });

  // Idle watchdog: reset a timer on every event; if nothing arrives within the
  // window, abort the stream and surface a typed error like streamChat does.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort(
        Object.assign(new Error("The model stream stalled (no data)."), {
          code: "stream_stalled",
        }),
      );
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  let emittedModel = false;
  try {
    armIdle();
    for await (const event of stream) {
      armIdle();
      if (event.type === "message_start") {
        // Emit the served model once, matching streamChat's model delta.
        const m = event.message.model;
        if (m && !emittedModel) {
          emittedModel = true;
          yield { model: m };
        }
      } else if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        if (event.delta.text) yield { text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    yield {
      finishReason: final.stop_reason ?? null,
      usage: mapUsage(final.usage),
      model: final.model,
    };
  } catch (e) {
    // A safety refusal or in-band error should surface with a code so the agent
    // loop reports it rather than ending silently (empty-turn class of bugs).
    if (e instanceof Error && !(e as { code?: string }).code) {
      (e as { code?: string }).code = "stream_error";
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

// A ToolCall builder kept here so callers that construct assistant history for
// persistence get the OpenAI-shaped tool_calls the DB/hydration expect, even
// when the underlying provider is Anthropic.
export function toOpenAiToolCall(
  id: string,
  name: string,
  input: unknown,
): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input ?? {}) },
  };
}
