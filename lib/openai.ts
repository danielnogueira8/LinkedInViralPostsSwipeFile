import type {
  ChatMessage,
  CompleteResult,
  EmbedResult,
  ImageGenerationResult,
  StreamDelta,
  ToolDef,
  Usage,
} from "./openrouter";
import {
  routesToNativeOpenAIModel as routesToNativeOpenAI,
} from "./model-provider-routing";
export {
  OPENAI_LUNA_MODEL,
  routesToNativeOpenAIModel as routesToNativeOpenAI,
} from "./model-provider-routing";

const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL?.replace(/\/+$/, "") || "https://api.openai.com/v1";

/** @deprecated Use routesToNativeOpenAI; legacy Claude slugs also route here. */
export const isOpenAIModel = routesToNativeOpenAI;

export function openAIModelId(model: string): string {
  const value = model.trim();
  if (/^(?:anthropic\/)?claude-/i.test(value)) return "gpt-5.6-luna";
  return value.replace(/^openai\//i, "");
}

function qualifiedOpenAIModel(model: unknown, fallback: string): string {
  const value = String(model || openAIModelId(fallback));
  return value.startsWith("openai/") ? value : `openai/${value}`;
}

function openAIHeaders(): Record<string, string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export class OpenAIHttpError extends Error {
  constructor(
    readonly status: number,
    operation: string,
    detail?: string,
  ) {
    super(
      `OpenAI ${operation} failed (${status})${detail ? `: ${detail}` : ""}`,
    );
    this.name = "OpenAIHttpError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function openAIFetch(
  path: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
        ...init,
        headers: { ...openAIHeaders(), ...(init.headers ?? {}) },
      });
      if (response.ok) return response;
      // Read the error body BEFORE discarding it — an OpenAI 400 names the
      // exact invalid parameter, and cancel() alone throws that diagnosis away.
      const detail = await response
        .text()
        .then((text) => text.replace(/\s+/g, " ").trim().slice(0, 500))
        .catch(() => "");
      const error = new OpenAIHttpError(
        response.status,
        operation,
        detail || undefined,
      );
      if (!isRetryableStatus(response.status) || attempt === 2) throw error;
      lastError = error;
    } catch (error) {
      if (
        init.signal?.aborted ||
        attempt === 2 ||
        (error instanceof OpenAIHttpError &&
          !isRetryableStatus(error.status))
      ) {
        throw error;
      }
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`OpenAI ${operation} failed`);
}

type ResponsesInputItem = Record<string, unknown>;

// The Responses API types a content block by which side of the conversation
// produced it: input roles carry `input_text`, but an assistant turn replayed
// as history must carry `output_text` (the only other accepted value being
// `refusal`). Stamping `input_text` on every role 400s the moment a transcript
// contains an assistant turn — which is why this only ever surfaced in the
// interview lane, where history accumulates: a first turn has no assistant
// message to replay, so it succeeds and every turn after it fails.
function textBlockType(role: ChatMessage["role"]): "input_text" | "output_text" {
  return role === "assistant" ? "output_text" : "input_text";
}

function messageContent(
  message: ChatMessage,
): Array<Record<string, unknown>> {
  const textType = textBlockType(message.role);
  if (typeof message.content === "string") {
    return [
      {
        type: textType,
        text: message.content,
      },
    ];
  }
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap<Record<string, unknown>>((block) => {
    if (block.type === "text") {
      return [
        {
          type: textType,
          text: block.text,
        },
      ];
    }
    // `input_image` / `input_file` are input-only block types, so an assistant
    // turn carrying media would 400 the same way `input_text` did. Media only
    // ever rides user turns today; dropping it on an assistant turn keeps a
    // future caller from re-opening this bug in a shape that is harder to read
    // (a 400 naming a block type nobody deliberately sent).
    if (message.role === "assistant") return [];
    if (block.type === "image_url") {
      return [
        {
          type: "input_image",
          image_url: block.image_url.url,
          detail: "auto",
        },
      ];
    }
    return [
      {
        type: "input_file",
        filename: block.file.filename,
        file_data: block.file.file_data,
      },
    ];
  });
}

// App-internal bookkeeping markers are persisted onto chat rows as synthetic
// `tool_calls` (`_turn_operation`, `_model_source_attached`, `_lead_magnet_
// selected`, …). No tool ever runs for them, so no result is ever produced.
//
// Chat Completions tolerates an unanswered tool call, which is why this was
// invisible on OpenRouter. The Responses API does not: every `function_call`
// must be followed by a `function_call_output`, so replaying one 400s with
//   No tool output found for function call _turn_operation.
// The whole family shares the leading-underscore convention, so filter on that
// rather than enumerating nine names that would drift out of sync.
function isPersistedMarkerCall(call: { function: { name: string } }): boolean {
  return call.function.name.startsWith("_");
}

function responsesInput(messages: ChatMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  // The pairing runs both ways: the Responses API rejects a `function_call`
  // with no output AND a `function_call_output` with no call. Emitting an
  // output only for a call we actually kept covers the marker case above and
  // any history where a tool row outlived its call (a pruned or compacted
  // transcript), instead of trading one 400 for its mirror image.
  const emittedCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !emittedCallIds.has(message.tool_call_id)) {
        continue;
      }
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
      });
      continue;
    }
    const content = messageContent(message);
    if (content.length) {
      input.push({ role: message.role, content });
    }
    for (const toolCall of message.tool_calls ?? []) {
      if (isPersistedMarkerCall(toolCall)) continue;
      emittedCallIds.add(toolCall.id);
      input.push({
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }
  return input;
}

function responsesTools(
  tools: ToolDef[] | undefined,
  plugins: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  const converted: Array<Record<string, unknown>> = (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }));
  if (plugins?.some((plugin) => plugin.id === "web")) {
    converted.push({ type: "web_search" });
  }
  return converted.length ? converted : undefined;
}

function mapUsage(raw: Record<string, unknown> | undefined): Usage | undefined {
  if (!raw) return undefined;
  const inputDetails = raw.input_tokens_details as
    | Record<string, unknown>
    | undefined;
  const outputDetails = raw.output_tokens_details as
    | Record<string, unknown>
    | undefined;
  return {
    prompt_tokens: Number(raw.input_tokens ?? 0),
    completion_tokens: Number(raw.output_tokens ?? 0),
    prompt_tokens_details: {
      cached_tokens: Number(inputDetails?.cached_tokens ?? 0),
    },
    completion_tokens_details: {
      reasoning_tokens: Number(outputDetails?.reasoning_tokens ?? 0),
    },
  };
}

function withWebSearchUsage(
  usage: Usage | undefined,
  output: Array<Record<string, unknown>>,
): Usage | undefined {
  const webSearchRequests = output.filter(
    (item) => item.type === "web_search_call",
  ).length;
  if (!usage && webSearchRequests === 0) return undefined;
  return {
    ...(usage ?? {}),
    prompt_tokens_details: {
      ...(usage?.prompt_tokens_details ?? {}),
      web_search_requests: webSearchRequests,
    },
  };
}

function responseBody(opts: {
  messages: ChatMessage[];
  model: string;
  maxTokens?: number;
  disableReasoning?: boolean;
  glmReasoning?: "high" | "none";
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  tools?: ToolDef[];
  forceTool?: string;
  toolChoice?: "auto" | "required" | "none";
  plugins?: Array<Record<string, unknown>>;
  sessionId?: string;
  cachePrompt?: boolean;
  stream?: boolean;
}): Record<string, unknown> {
  const tools = responsesTools(opts.tools, opts.plugins);
  const effort =
    opts.disableReasoning
      ? "none"
      : opts.glmReasoning === "none"
        ? "none"
      : opts.reasoningEffort === "minimal"
        ? "low"
        : opts.reasoningEffort ??
          (opts.stream && opts.tools?.length ? "none" : "low");
  return {
    model: openAIModelId(opts.model),
    input: responsesInput(opts.messages),
    max_output_tokens: opts.maxTokens ?? (opts.stream ? 4096 : 1024),
    store: false,
    ...(opts.stream ? { stream: true } : {}),
    ...(tools ? { tools } : {}),
    ...(opts.forceTool
      ? { tool_choice: { type: "function", name: opts.forceTool } }
      : opts.toolChoice
        ? { tool_choice: opts.toolChoice }
        : tools
          ? { tool_choice: "auto" }
          : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(opts.sessionId && opts.cachePrompt !== false
      ? { prompt_cache_key: opts.sessionId }
      : {}),
    ...(opts.cachePrompt === false
      ? { prompt_cache_options: { mode: "explicit" } }
      : {}),
  };
}

function responseOutputText(output: Array<Record<string, unknown>>): string {
  return output
    .filter((item) => item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content as Array<Record<string, unknown>>)
    .filter((block) => block.type === "output_text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}

export async function completeChatOpenAI(opts: {
  messages: ChatMessage[];
  model: string;
  maxTokens?: number;
  disableReasoning?: boolean;
  glmReasoning?: "high" | "none";
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  tools?: ToolDef[];
  forceTool?: string;
  plugins?: Array<Record<string, unknown>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  sessionId?: string;
  cachePrompt?: boolean;
}): Promise<CompleteResult> {
  const timeout = opts.timeoutMs
    ? AbortSignal.timeout(Math.max(1, opts.timeoutMs))
    : undefined;
  const signal =
    timeout && opts.signal
      ? AbortSignal.any([opts.signal, timeout])
      : timeout ?? opts.signal;
  const response = await openAIFetch(
    "/responses",
    {
      method: "POST",
      body: JSON.stringify(responseBody(opts)),
      signal,
    },
    "response",
  );
  const parsed = (await response.json()) as Record<string, unknown>;
  const output = Array.isArray(parsed.output)
    ? (parsed.output as Array<Record<string, unknown>>)
    : [];
  const toolCall = output.find((item) => item.type === "function_call");
  let toolArgs: Record<string, unknown> | null = null;
  if (typeof toolCall?.arguments === "string") {
    try {
      const value = JSON.parse(toolCall.arguments);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        toolArgs = value;
      }
    } catch {
      toolArgs = null;
    }
  }
  const citations: CompleteResult["citations"] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content as Array<Record<string, unknown>>) {
      if (!Array.isArray(block.annotations)) continue;
      for (const annotation of block.annotations as Array<Record<string, unknown>>) {
        if (
          annotation.type === "url_citation" &&
          typeof annotation.url === "string"
        ) {
          citations.push({
            url: annotation.url,
            title: typeof annotation.title === "string" ? annotation.title : "",
            content: "",
          });
        }
      }
    }
  }
  return {
    text:
      typeof parsed.output_text === "string"
        ? parsed.output_text
        : responseOutputText(output),
    toolArgs,
    finishReason:
      parsed.status === "completed"
        ? "stop"
        : parsed.status === "incomplete"
          ? "length"
          : typeof parsed.status === "string"
            ? parsed.status
            : null,
    usage: withWebSearchUsage(
      mapUsage(parsed.usage as Record<string, unknown> | undefined),
      output,
    ),
    model: qualifiedOpenAIModel(parsed.model, opts.model),
    citations,
  };
}

export async function* streamChatOpenAI(opts: {
  messages: ChatMessage[];
  model: string;
  maxTokens?: number;
  tools?: ToolDef[];
  signal?: AbortSignal;
  toolChoice?: "auto" | "required" | "none";
  sessionId?: string;
  cachePrompt?: boolean;
}): AsyncGenerator<StreamDelta> {
  const deadline = AbortSignal.timeout(285_000);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, deadline])
    : deadline;
  const response = await openAIFetch(
    "/responses",
    {
      method: "POST",
      body: JSON.stringify(responseBody({ ...opts, stream: true })),
      signal,
    },
    "stream",
  );
  if (!response.body) throw new Error("OpenAI returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, { id?: string; name?: string }>();
  let webSearchRequests = 0;
  let buffer = "";
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("OpenAI stream stalled (no data).")),
        45_000,
      );
    });
    const { done, value } = await Promise.race([reader.read(), idle]).finally(
      () => {
        if (timer) clearTimeout(timer);
      },
    );
    buffer += decoder.decode(value, { stream: !done });
    const records = buffer.split(/\r?\n\r?\n/);
    buffer = records.pop() ?? "";
    for (const record of records) {
      const data = record
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("");
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as Record<string, unknown>;
      const type = String(event.type ?? "");
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        yield { text: event.delta };
      } else if (type === "response.output_item.added") {
        const item = event.item as Record<string, unknown> | undefined;
        const index = Number(event.output_index ?? 0);
        if (item?.type === "function_call") {
          const current = {
            id: typeof item.call_id === "string" ? item.call_id : undefined,
            name: typeof item.name === "string" ? item.name : undefined,
          };
          calls.set(index, current);
          yield { toolCalls: [{ index, ...current }] };
        } else if (item?.type === "web_search_call") webSearchRequests += 1;
      } else if (
        type === "response.function_call_arguments.delta" &&
        typeof event.delta === "string"
      ) {
        const index = Number(event.output_index ?? 0);
        yield {
          toolCalls: [
            { index, ...calls.get(index), argumentsFragment: event.delta },
          ],
        };
      } else if (type === "response.completed" || type === "response.incomplete") {
        const final = event.response as Record<string, unknown> | undefined;
        const usage = mapUsage(
          final?.usage as Record<string, unknown> | undefined,
        );
        yield {
          finishReason: type === "response.completed" ? "stop" : "length",
          usage: {
            ...(usage ?? {}),
            prompt_tokens_details: {
              ...(usage?.prompt_tokens_details ?? {}),
              web_search_requests: webSearchRequests,
            },
          },
          model: qualifiedOpenAIModel(final?.model, opts.model),
        };
      } else if (type === "response.failed" || type === "error") {
        throw new Error("OpenAI stream failed.");
      }
    }
    if (done) break;
  }
}

export async function embedTextOpenAI(
  texts: string[],
  opts: { model: string; signal?: AbortSignal },
): Promise<EmbedResult> {
  const response = await openAIFetch(
    "/embeddings",
    {
      method: "POST",
      body: JSON.stringify({
        model: openAIModelId(opts.model),
        input: texts,
        encoding_format: "float",
      }),
      signal: opts.signal,
    },
    "embeddings",
  );
  const parsed = (await response.json()) as Record<string, unknown>;
  const rows = Array.isArray(parsed.data)
    ? (parsed.data as Array<Record<string, unknown>>)
    : [];
  const embeddings: number[][] = new Array(texts.length);
  if (rows.length !== texts.length) {
    throw new Error(
      `OpenAI embeddings returned ${rows.length} vectors for ${texts.length} inputs`,
    );
  }
  for (const row of rows) {
    const index = Number(row.index);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= texts.length ||
      embeddings[index]
    ) {
      throw new Error(
        embeddings[index]
          ? `OpenAI embeddings returned duplicate index ${String(row.index)}`
          : `OpenAI embeddings returned invalid index ${String(row.index)}`,
      );
    }
    if (!Array.isArray(row.embedding)) {
      throw new Error(`OpenAI embeddings omitted vector ${index}`);
    }
    embeddings[index] = row.embedding as number[];
  }
  for (let index = 0; index < embeddings.length; index += 1) {
    if (!embeddings[index]) {
      throw new Error(`OpenAI embeddings missing vector ${index}`);
    }
  }
  const usage = parsed.usage as Record<string, unknown> | undefined;
  return {
    embeddings,
    model: qualifiedOpenAIModel(parsed.model, opts.model),
    promptTokens: Number(usage?.prompt_tokens ?? usage?.total_tokens ?? 0),
  };
}

export async function generateImageOpenAI(opts: {
  prompt: string;
  referenceDataUrl?: string;
  model: string;
  aspectRatio?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  signal?: AbortSignal;
}): Promise<ImageGenerationResult> {
  const landscape = opts.aspectRatio?.startsWith("16:");
  const portrait = opts.aspectRatio?.endsWith(":16");
  let response: Response;
  if (opts.referenceDataUrl) {
    const match = opts.referenceDataUrl.match(
      /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/,
    );
    if (!match) throw new Error("OpenAI reference image must be a base64 data URL.");
    const form = new FormData();
    form.set("model", openAIModelId(opts.model));
    form.set("prompt", opts.prompt);
    form.set("n", "1");
    form.set("size", landscape ? "1536x1024" : portrait ? "1024x1536" : "1024x1024");
    form.set("output_format", opts.outputFormat ?? "png");
    form.set(
      "image",
      new Blob([Buffer.from(match[2], "base64")], { type: match[1] }),
      `reference.${match[1].split("/")[1] || "png"}`,
    );
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set");
    response = await fetch(`${OPENAI_BASE_URL}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: opts.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenAIHttpError(response.status, "image edit");
    }
  } else {
    response = await openAIFetch(
      "/images/generations",
      {
        method: "POST",
        body: JSON.stringify({
        model: openAIModelId(opts.model),
        prompt: opts.prompt,
        n: 1,
        size: landscape ? "1536x1024" : portrait ? "1024x1536" : "1024x1024",
        output_format: opts.outputFormat ?? "png",
        }),
        signal: opts.signal,
      },
      "image generation",
    );
  }
  const parsed = (await response.json()) as Record<string, unknown>;
  const first = Array.isArray(parsed.data)
    ? (parsed.data[0] as Record<string, unknown> | undefined)
    : undefined;
  if (typeof first?.b64_json !== "string") {
    throw new Error("OpenAI did not return generated image bytes.");
  }
  const format = opts.outputFormat ?? "png";
  return {
    b64Json: first.b64_json,
    mimeType: format === "jpeg" ? "image/jpeg" : `image/${format}`,
    usage: mapUsage(parsed.usage as Record<string, unknown> | undefined),
    model: `openai/${openAIModelId(opts.model)}`,
  };
}
