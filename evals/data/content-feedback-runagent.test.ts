import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";
import { createCoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";

const captured: { messages: ChatMessage[]; streamError: Error | null } = {
  messages: [],
  streamError: null,
};

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: (opts: { messages: ChatMessage[] }) => {
      captured.messages = opts.messages;
      return (async function* () {
        if (captured.streamError) throw captured.streamError;
        yield {
          text: "ok.",
          finishReason: "stop" as const,
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 3 },
            cost: 0.123,
          },
        };
      })();
    },
  };
});

const { runAgent } = await import("@/lib/agent");

async function run(opts: {
  feedbackMemory?: Array<{
    rating: "up" | "down";
    reasons: string[];
    note: string | null;
    body_snapshot: string;
  }>;
  preferences?: Array<{ rule: string }>;
  noModelFormatBlock?: string;
  telemetry?: ReturnType<typeof createCoworkTurnTelemetry>;
}): Promise<void> {
  for await (const _ of runAgent({
    history: [{ role: "user", content: "hello there friend" }],
    workspaceId: "ws",
    preferences: opts.preferences as never,
    feedbackMemory: opts.feedbackMemory as never,
    noModelFormatBlock: opts.noModelFormatBlock,
    telemetry: opts.telemetry,
  })) {
    void _;
  }
}

function systemMsgs(): ChatMessage[] {
  return captured.messages.filter((m) => m.role === "system");
}

function asText(m: ChatMessage): string {
  return typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      : "";
}

function systemText(): string {
  return systemMsgs().map(asText).join("\n\n");
}

beforeEach(() => {
  captured.messages = [];
  captured.streamError = null;
});

describe("runAgent — feedback memory reaches the model", () => {
  test("legacy Cowork records its model, tokens, cache, cost, and stage outcome", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "legacy-stage",
        workspaceId: "ws",
        route: "legacy_agent",
        requestedContract: { kind: "partial", expectedCount: 1 },
      },
      sink,
    );
    await run({ telemetry });
    telemetry.finish({
      deliveredContract: { kind: "partial", deliveredCount: 1 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });

    expect(sink.mock.calls[0][0]).toMatchObject({
      input_tokens: 12,
      output_tokens: 4,
      cached_input_tokens: 3,
      charged_cost_usd: 0.123,
    });
    expect(sink.mock.calls[0][0].stage_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "legacy_agent",
          model: expect.any(String),
          provider: "openrouter",
          outcome: "accepted",
          input_tokens: 12,
          output_tokens: 4,
          cached_input_tokens: 3,
        }),
      ]),
    );
  });

  test("a zero-token legacy provider failure still records a failed stage", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "legacy-zero-token-failure",
        workspaceId: "ws",
        route: "legacy_agent",
        requestedContract: { kind: "answer", expectedCount: 1 },
      },
      sink,
    );
    captured.streamError = Object.assign(new Error("provider unavailable"), {
      status: 503,
    });
    await run({ telemetry });
    telemetry.finish({
      deliveredContract: { kind: "answer", deliveredCount: 0 },
      provenanceStatus: "not_required",
      terminalOutcome: "hard_failure",
    });

    expect(sink.mock.calls[0][0].stage_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "legacy_agent",
          outcome: "failed",
          reason_code: "error",
          input_tokens: 0,
          output_tokens: 0,
        }),
      ]),
    );
  });

  test("feedback memory appears in a separate system message", async () => {
    await run({
      feedbackMemory: [
        {
          rating: "down",
          reasons: ["Too generic"],
          note: "avoid vague language",
          body_snapshot: "Unlock your potential today.",
        },
      ],
    });

    expect(systemText()).toContain("recent taste feedback");
    expect(systemText()).toContain("Too generic");
    expect(systemText()).toContain("avoid vague language");
    expect(systemMsgs().length).toBe(3);
  });

  test("feedback sits after hard preferences and before no-model format", async () => {
    await run({
      preferences: [{ rule: "Never use em-dashes" }],
      feedbackMemory: [
        {
          rating: "up",
          reasons: ["Right voice"],
          note: null,
          body_snapshot: "This one sounds like me.",
        },
      ],
      noModelFormatBlock: "Internal no-model LinkedIn format selected: Tactical Listicle",
    });

    const msgs = systemMsgs();
    const prefIdx = msgs.findIndex((m) => asText(m).includes("hard rules"));
    const feedbackIdx = msgs.findIndex((m) => asText(m).includes("recent taste feedback"));
    const formatIdx = msgs.findIndex((m) =>
      asText(m).includes("Internal no-model LinkedIn format selected"),
    );

    expect(prefIdx).toBeGreaterThan(-1);
    expect(feedbackIdx).toBeGreaterThan(prefIdx);
    expect(formatIdx).toBeGreaterThan(feedbackIdx);
  });

  test("omitted or empty feedback does not add a system message", async () => {
    await run({ feedbackMemory: [] });
    expect(systemMsgs().length).toBe(2);

    captured.messages = [];
    await run({});
    expect(systemMsgs().length).toBe(2);
  });
});
