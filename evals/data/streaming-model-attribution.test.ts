import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Model-attribution follow-up for lib/agent/run.ts streamChat() (backlog #6):
// the turn-level usage_events row used to log CHAT_MODEL (the requested
// alias) unconditionally, even when OpenRouter's stream chunks echoed a
// different served model. This proves the turn now attributes to the LAST
// round's served model (every round in the loop requests the same CHAT_MODEL
// alias — there's no per-round model switching — so the last round's served
// model is the right one for the whole turn's usage row), and falls back to
// the requested alias when the mocked stream never sends one.
// ---------------------------------------------------------------------------

const usageLogCalls: Array<{
  kind: string;
  model: string;
  metadata?: unknown;
}> = [];
const streamRef: {
  current: () => AsyncGenerator<{
    text?: string;
    finishReason?: string;
    usage?: unknown;
    model?: string;
  }>;
} = {
  current: async function* () {
    yield {
      text: "ok.",
      finishReason: "stop",
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    };
  },
};

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async (
      kind: string,
      model: string,
      _usage: unknown,
      _workspaceId: unknown,
      metadata?: unknown,
    ) => {
      usageLogCalls.push({ kind, model, metadata });
    },
    streamChat: () => streamRef.current(),
  };
});

const { runAgent } = await import("@/lib/agent");
const { CHAT_MODEL } = await import("@/lib/openrouter");

async function run(): Promise<void> {
  for await (const _ of runAgent({
    history: [{ role: "user", content: "write me a short update" }],
    workspaceId: "ws",
  })) {
    void _;
  }
}

beforeEach(() => {
  usageLogCalls.length = 0;
});

describe("runAgent — turn-level usage attributes to the served model", () => {
  test("falls back to CHAT_MODEL when the stream never echoes a served model", async () => {
    streamRef.current = async function* () {
      yield {
        text: "A short, complete update.",
        finishReason: "stop",
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      };
    };
    await run();
    const call = usageLogCalls.find((c) => c.kind === "chat");
    expect(call).toBeDefined();
    expect(call?.model).toBe(CHAT_MODEL);
  });

  test("attributes to the LAST round's served model when the stream echoes one", async () => {
    streamRef.current = async function* () {
      yield { model: "z-ai/glm-5.2-served-variant" };
      yield {
        text: "A short, complete update.",
        finishReason: "stop",
        usage: { prompt_tokens: 12, completion_tokens: 4 },
        model: "z-ai/glm-5.2-served-variant",
      };
    };
    await run();
    const call = usageLogCalls.find((c) => c.kind === "chat");
    expect(call).toBeDefined();
    expect(call?.model).toBe("z-ai/glm-5.2-served-variant");
    expect(call?.metadata).toMatchObject({
      requested_model: CHAT_MODEL,
    });
  });
});
