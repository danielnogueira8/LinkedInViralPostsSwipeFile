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

// A Claude model, in either the bare Anthropic form (`claude-sonnet-5`) or the
// OpenRouter-prefixed form the app uses everywhere as its "Claude" slug
// (`anthropic/claude-sonnet-5`). Both must route to Anthropic under the flag —
// the app's writer primary, every fallback chain, vision, and the specialists
// all default to the PREFIXED form, so matching only the bare form (as the
// original seam did) sent all of that back through OpenRouter.
export function isAnthropicModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("claude-") || m.startsWith("anthropic/claude-");
}

// The bare model id Anthropic's API expects. Strips the `anthropic/` provider
// prefix that OpenRouter slugs carry. `anthropic/claude-sonnet-5` →
// `claude-sonnet-5`; a bare id is returned unchanged.
//
// OpenRouter slugs use DOTTED minor versions (`claude-haiku-4.5`) but the
// Anthropic API dashes them (`claude-haiku-4-5`) — and for haiku only the
// DATED id exists, so a bare dot→dash still 404s ("model: claude-haiku-4.5"
// not_found_error took down news search when the provider flag moved it onto
// this adapter). Map the slugs the app actually runs to their exact API ids;
// for anything unmapped, fall back to the dot→dash transform (current-gen
// aliases like `claude-sonnet-4-6` resolve) rather than passing a guaranteed-
// invalid dotted id through.
const ANTHROPIC_MODEL_ID_MAP: Record<string, string> = {
  "claude-haiku-4.5": "claude-haiku-4-5-20251001",
  "claude-opus-4.5": "claude-opus-4-5-20251101",
  "claude-sonnet-4.5": "claude-sonnet-4-5-20250929",
  "claude-opus-4.1": "claude-opus-4-1-20250805",
};
export function toAnthropicModelId(model: string): string {
  const bare = model.replace(/^anthropic\//i, "");
  const mapped = ANTHROPIC_MODEL_ID_MAP[bare];
  if (mapped) return mapped;
  // `claude-sonnet-4.6` → `claude-sonnet-4-6`; already-dashed/undotted ids are
  // returned unchanged.
  return bare.replace(/(\d)\.(\d)/g, "$1-$2");
}

// Adaptive thinking and output_config.effort are gen-5-only: older models 400
// on both ("adaptive thinking is not supported on this model",
// "This model does not support the effort parameter" — claude-haiku-4-5
// rejects each), so calls to anything else must go out plain. Takes the
// RESOLVED API id (post toAnthropicModelId).
export function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(?:sonnet|opus|fable)-5(?:-|$)/i.test(model);
}

// True when the resolved model should be served by Anthropic. The flag gates the
// whole thing; the Claude check is a guard so a stray non-Claude override never
// reaches the Anthropic endpoint.
export function shouldUseAnthropic(model: string): boolean {
  return process.env.AI_PROVIDER === "anthropic" && isAnthropicModel(model);
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

/**
 * Put the tool-block cache breakpoint on the genuinely LAST tool.
 *
 * Anthropic renders tools → system → messages and caches a prefix, so a
 * breakpoint on the final tool caches the whole tool block. This must run
 * AFTER every tool is assembled: the web_search server tool is appended later
 * for grounded calls, and marking before that left the breakpoint mid-list, so
 * grounded requests paid a cache write for a prefix that stopped short of the
 * full tool set. Tool schemas are stable across turns, so this is otherwise a
 * free win.
 *
 * Exported for tests — the ordering is invisible at runtime and only shows up
 * as a silently worse hit rate.
 */
export function markLastToolCached(
  tools: Anthropic.ToolUnion[] | undefined,
): void {
  if (!tools?.length) return;
  // Clear any earlier marker so we never emit two tool-block breakpoints (they
  // are a limited resource — 4 per request).
  for (const tool of tools) {
    delete (tool as { cache_control?: unknown }).cache_control;
  }
  // One-hour TTL: the default 5-minute window dies between turns, so every
  // turn paid a FULL cache write (~9k tokens at 1.25x) with ~zero reads. The
  // 1h window costs 2x the 5m write but reads stay at 0.1x — any prefix read
  // more than ~3 times in the hour (a normal writing session) comes out well
  // ahead. See docs: prompt caching TTL pricing.
  (
    tools[tools.length - 1] as {
      cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
    }
  ).cache_control = { type: "ephemeral", ttl: "1h" };
}

// The OpenRouter callers request live web search via `plugins: [{id:"web", ...}]`
// (news-search.ts, grounded web research in agent.ts). Anthropic does web search
// via a server tool instead, so detect the plugin and translate it.
export function webSearchMaxUses(
  plugins: Array<Record<string, unknown>> | undefined,
): number | undefined {
  const web = plugins?.find((p) => p.id === "web");
  if (!web) return undefined;
  const n = web.max_results;
  return typeof n === "number" && n > 0 ? n : 5;
}

// Extract grounded sources from a completed message into the app's citation
// shape ({url, title, content}). Anthropic returns web-search hits two ways: the
// `web_search_tool_result` blocks carry url/title but NO readable excerpt
// (encrypted_content is opaque), while the model's `text` blocks carry
// `citations` of type `web_search_result_location` with the actual `cited_text`.
// The excerpt is what grounded research REQUIRES (it fails closed on empty
// content), so we read citations from the text blocks and dedupe by url. Result
// blocks with no matching text citation are added url/title-only as a fallback.
export function extractCitations(
  content: Anthropic.ContentBlock[],
): Array<{ url: string; title: string; content: string }> {
  const byUrl = new Map<string, { url: string; title: string; content: string }>();
  for (const block of content) {
    if (block.type !== "text" || !block.citations) continue;
    for (const c of block.citations) {
      if (c.type !== "web_search_result_location") continue;
      const url = typeof c.url === "string" ? c.url : "";
      if (!url) continue;
      const existing = byUrl.get(url);
      const cited = typeof c.cited_text === "string" ? c.cited_text : "";
      if (existing) {
        // Accumulate additional cited spans for the same source.
        if (cited && !existing.content.includes(cited)) {
          existing.content = `${existing.content}\n${cited}`.trim();
        }
      } else {
        byUrl.set(url, {
          url,
          title: typeof c.title === "string" && c.title ? c.title : url,
          content: cited,
        });
      }
    }
  }
  // Fallback: surface any searched result that the model didn't cite in text,
  // url/title-only (callers that need an excerpt will skip these).
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    const results = block.content;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      if (r.type !== "web_search_result" || !r.url || byUrl.has(r.url)) continue;
      byUrl.set(r.url, { url: r.url, title: r.title || r.url, content: "" });
    }
  }
  return [...byUrl.values()];
}

// Wrap the hoisted system string as a single cached text block. The app's system
// prompt is large and stable per workspace + skill set (writer ~13k tokens: the
// skill/policy/voice stack), and it was NEVER cached — the adapter hoisted it to
// a plain string, which cannot carry cache_control. Emitting the array form with
// one ephemeral breakpoint caches the ENTIRE system prefix for every Anthropic
// call (writer, planner, specialists) in one place. On repeat turns the prefix
// bills at ~0.1x instead of full price.
//
// Per-variation lines (v1/v2/v3) that some writer branches interpolate into the
// system string just make each variation its own cache entry — no partial-prefix
// breakage, since the whole system is one block. Non-variation turns still hit.
function cachedSystem(system: string): Anthropic.TextBlockParam[] {
  // Same 1h TTL rationale as markLastToolCached: a 5-minute cache dies between
  // turns and every turn rewrites ~9-13k tokens at 1.25x; the 1h window turns
  // those into 0.1x reads across a normal writing session.
  return [
    {
      type: "text",
      text: system,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
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
  const cached = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    // Anthropic's input_tokens EXCLUDES cached + cache-creation tokens, but the
    // whole downstream cost pipeline is built on OpenRouter's semantics, where
    // prompt_tokens is the TOTAL input and cached/cache-write are the
    // cheaper-billed subsets. Passing Anthropic's fresh-only count through made
    // the pricing math subtract the cached amounts from an already-fresh total
    // — undercounting every Anthropic turn by ~half (and far more on warm
    // cache-read turns), which is why credits stopped deducting correctly.
    prompt_tokens: (u.input_tokens ?? 0) + cached + cacheWrite,
    completion_tokens: u.output_tokens ?? 0,
    prompt_tokens_details: {
      cached_tokens: cached,
      cache_write_tokens: cacheWrite,
      ...(u.server_tool_use?.web_search_requests
        ? { web_search_requests: u.server_tool_use.web_search_requests }
        : {}),
    },
  };
}

// Map Anthropic stop reasons to the OpenAI finishReason vocabulary the whole app
// switches on. This is load-bearing: the direct writer derives
// `envelopeComplete` from `finishReason === null || === "stop"` (writer.ts), and
// the finalizer flags `finishReason === "length"` as truncated. Anthropic
// returns "end_turn" / "max_tokens" / "tool_use", which match NONE of those — so
// without this map every completed Sonnet draft looked truncated and the writer
// retried forever (the "couldn't complete a reliable post" loop).
//   end_turn / stop_sequence → "stop"   (complete)
//   max_tokens               → "length" (genuinely truncated)
//   tool_use                 → "tool_calls"
//   refusal / pause_turn     → passthrough (handled elsewhere / rare)
export function mapStopReason(
  stop: Anthropic.Message["stop_reason"],
): string | null {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case null:
    case undefined:
      return null;
    default:
      // refusal, pause_turn, or any future reason — surface verbatim so callers
      // that special-case them still can; it just won't read as "complete".
      return stop;
  }
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
  // See the option doc in openrouter.ts. Defaults to caching ON.
  cachePrompt?: boolean;
}): Promise<CompleteResult> {
  const requested = opts.model || anthropicChatModel();
  const model = toAnthropicModelId(requested);
  const { system, messages } = translateMessages(opts.messages);
  const { effort, thinkingOff } = effortFor(opts);
  // Give Sonnet headroom: heavier tokenizer + thinking. Floor at 2048 even when
  // a legacy caller passes the old 1024 default.
  const maxTokens = Math.max(opts.maxTokens ?? 2048, 2048);

  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(supportsAdaptiveThinking(model)
      ? {
          thinking: thinkingOff
            ? ({ type: "disabled" } as const)
            : ({ type: "adaptive" } as const),
          output_config: { effort },
        }
      : {}),
  };
  // cachePrompt:false sends the system prompt as a plain string (a string
  // cannot carry cache_control) and skips the tool breakpoint, so the call
  // pays no cache-write premium. See the option's doc in openrouter.ts.
  const cache = opts.cachePrompt !== false;
  if (system) body.system = cache ? cachedSystem(system) : system;
  if (opts.tools?.length) {
    body.tools = toAnthropicTools(opts.tools);
    body.tool_choice = opts.forceTool
      ? { type: "tool", name: opts.forceTool }
      : { type: "auto" };
  }
  // Translate the OpenRouter web-search plugin into Anthropic's web_search
  // server tool so news + grounded research keep working under the flag. The
  // server runs the search and returns grounded results; we harvest citations
  // from the response below. (Server tools run alongside any user tools.)
  const maxUses = webSearchMaxUses(opts.plugins);
  if (maxUses !== undefined) {
    const webTool: Anthropic.WebSearchTool20260209 = {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: maxUses,
    };
    body.tools = [...(body.tools ?? []), webTool];
  }
  // Every tool is now assembled (user tools + any web_search server tool), so
  // the breakpoint can land on the real last one.
  if (cache) markLastToolCached(body.tools);

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
    finishReason: mapStopReason(response.stop_reason),
    usage: mapUsage(response.usage),
    model: response.model || model,
    citations: maxUses !== undefined ? extractCitations(response.content) : [],
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
  // See the option doc in openrouter.ts. Defaults to caching ON.
  cachePrompt?: boolean;
}): AsyncGenerator<StreamDelta> {
  const model = toAnthropicModelId(opts.model || anthropicChatModel());
  const { system, messages } = translateMessages(opts.messages);
  const maxTokens = Math.max(opts.maxTokens ?? 4096, 2048);

  const body: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
    ...(supportsAdaptiveThinking(model)
      ? {
          thinking: { type: "adaptive" } as const,
          output_config: { effort: "high" as const },
        }
      : {}),
  };
  const cache = opts.cachePrompt !== false;
  if (system) body.system = cache ? cachedSystem(system) : system;
  if (opts.tools?.length && opts.toolChoice !== "none") {
    body.tools = toAnthropicTools(opts.tools);
    // No server tools are appended on the streaming path, so the last user tool
    // is the last tool.
    if (cache) markLastToolCached(body.tools);
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
  // `stalled` records that WE fired, so the catch can re-throw the coded error
  // even if the SDK surfaces a generic AbortError for the aborted read.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
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
      finishReason: mapStopReason(final.stop_reason),
      usage: mapUsage(final.usage),
      model: final.model,
    };
  } catch (e) {
    // If the idle watchdog fired, surface the stall regardless of how the SDK
    // reported the aborted read.
    if (stalled) {
      throw Object.assign(new Error("The model stream stalled (no data)."), {
        code: "stream_stalled",
      });
    }
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
