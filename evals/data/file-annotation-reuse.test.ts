import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";

const state = vi.hoisted(() => ({ calls: [] as ChatMessage[][] }));

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: async function* (opts: { messages: ChatMessage[] }) {
      state.calls.push(structuredClone(opts.messages));
      if (state.calls.length === 1) {
        yield {
          fileAnnotations: [
            {
              type: "file" as const,
              file: {
                hash: "pdf-hash",
                name: "brief.pdf",
                content: [{ type: "text" as const, text: "Parsed brief text" }],
              },
            },
          ],
          toolCalls: [
            {
              index: 0,
              id: "voice-call",
              name: "get_voice",
              argumentsFragment: "{}",
            },
          ],
          finishReason: "tool_calls" as const,
        };
        return;
      }
      yield { text: "Done.", finishReason: "stop" as const };
    },
  };
});

vi.mock("@/lib/agent/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/tools")>()),
  runTool: async () => ({ ok: true, voice: { summary: "Direct" } }),
}));
vi.mock("@/lib/agent/cancel", () => ({
  isCancelRequested: async () => false,
}));

const { runAgent } = await import("@/lib/agent");

describe("parsed document reuse across agent rounds", () => {
  test("adds first-round file annotations to the assistant message sent next", async () => {
    state.calls = [];
    const history: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Use this brief." },
          {
            type: "file",
            file: {
              filename: "brief.pdf",
              file_data: "data:application/pdf;base64,AA==",
            },
          },
        ],
      },
    ];

    for await (const event of runAgent({
      history,
      workspaceId: "",
      skipDecision: true,
    })) {
      void event;
    }

    expect(state.calls).toHaveLength(2);
    expect(state.calls[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          annotations: [
            expect.objectContaining({
              type: "file",
              file: expect.objectContaining({ hash: "pdf-hash" }),
            }),
          ],
        }),
      ]),
    );
    expect(
      state.calls[1].some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === "file"),
      ),
    ).toBe(false);
  });
});
