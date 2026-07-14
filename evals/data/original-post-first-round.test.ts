import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "@/lib/agent/contracts";
import type { ChatMessage } from "@/lib/openrouter";

const state = vi.hoisted(() => ({
  controller: null as AbortController | null,
  streamCalls: 0,
  firstRoundMessages: [] as ChatMessage[],
  firstRoundTools: [] as string[],
  slowFirstDraftRound: false,
  failFirstDraftRound: false,
  abortFirstDraftRound: false,
  reasoningAttempts: [] as Array<"high" | "none" | undefined>,
}));

vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decideTurn: async () => ({ shouldAsk: false }),
}));

vi.mock("@/lib/agent/specialists/freshness", () => ({
  computeFreshnessConstraint: async () => ({ block: "", markers: [] }),
}));

vi.mock("@/lib/batch/exemplar-retrieval", () => ({
  buildExemplarBlock: async () => ({
    block: "",
    viralCount: 0,
    mediocreCount: 0,
  }),
}));

vi.mock("@/lib/batch/pattern-brief", () => ({
  getPatternBrief: async () => null,
  renderPatternBriefBlock: () => "",
}));

vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/tools")>();
  return {
    ...actual,
    runTool: async (name: string, args: Record<string, unknown>, workspaceId: string, signal?: AbortSignal) => {
      if (name === "get_voice") {
        return {
          ok: true,
          voice: {
            display_name: "Daniel Nogueira",
            summary: "A direct, practical LinkedIn ghostwriter.",
            profile: {
              tone: ["direct", "high-conviction"],
              format_patterns: {
                sentence_rhythm: "Short, punchy sentences.",
                paragraphing: "One thought per paragraph.",
              },
              exemplars: ["Strong claims travel. Soft ones die in the feed."],
            },
          },
        };
      }
      return actual.runTool(name, args, workspaceId, signal);
    },
  };
});

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: (opts: {
      messages: ChatMessage[];
      tools?: Array<{ function: { name: string } }>;
      signal?: AbortSignal;
      glmReasoning?: "high" | "none";
    }) => {
      state.streamCalls++;
      state.reasoningAttempts.push(opts.glmReasoning);
      const toolNames = (opts.tools ?? []).map((tool) => tool.function.name);
      if (state.streamCalls === 1) {
        state.firstRoundMessages = opts.messages;
        state.firstRoundTools = toolNames;
      }

      return (async function* () {
        // This recreates the production failure deterministically: when voice
        // is not preloaded, the first expensive round can do nothing except ask
        // for it. The user stops at that boundary and receives no draft.
        if (state.streamCalls === 1 && toolNames.includes("get_voice")) {
          yield {
            toolCalls: [
              {
                index: 0,
                id: "call_voice",
                name: "get_voice",
                argumentsFragment: "{}",
              },
            ],
            finishReason: "tool_calls" as const,
            usage: { prompt_tokens: 14_539, completion_tokens: 197 },
          };
          state.controller?.abort();
          return;
        }

        if (state.controller?.signal.aborted || opts.messages.some((message) => message.role === "tool")) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }

        if (state.slowFirstDraftRound && state.streamCalls === 1) {
          await new Promise<never>((_resolve, reject) => {
            const rejectAbort = () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (opts.signal?.aborted) rejectAbort();
            else
              opts.signal?.addEventListener("abort", rejectAbort, {
                once: true,
              });
          });
        }

        if (state.failFirstDraftRound && state.streamCalls === 1) {
          const error = new Error("OpenRouter upstream unavailable");
          (error as Error & { code?: number }).code = 503;
          throw error;
        }

        if (state.abortFirstDraftRound && state.streamCalls === 1) {
          state.controller?.abort();
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }

        yield {
          toolCalls: [
            {
              index: 0,
              id: "call_render",
              name: "render_post",
              argumentsFragment: JSON.stringify({
                body: [
                  "Your personal brand is career leverage you own.",
                  "",
                  "A job title disappears when you leave.",
                  "A reputation follows you into every room.",
                  "",
                  "Build the asset before you need it.",
                ].join("\n"),
              }),
            },
          ],
          finishReason: "tool_calls" as const,
          usage: { prompt_tokens: 15_000, completion_tokens: 250 },
        };
      })();
    },
  };
});

const { runAgent } = await import("@/lib/agent");

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

beforeEach(() => {
  state.controller = new AbortController();
  state.streamCalls = 0;
  state.firstRoundMessages = [];
  state.firstRoundTools = [];
  state.slowFirstDraftRound = false;
  state.failFirstDraftRound = false;
  state.abortFirstDraftRound = false;
  state.reasoningAttempts = [];
});

describe("ordinary original-post first-round delivery", () => {
  test("preloads voice and renders the draft without a get_voice-only round", async () => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Write an original post in my voice about how building a personal brand is the biggest leverage you can build for your career. Choose a proven framework that fits the topic, but do not model it after one specific source post.",
        },
      ],
      workspaceId: "workspace-1",
      signal: state.controller?.signal,
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: {
          display_name: "Daniel Nogueira",
          summary: "A direct, practical LinkedIn ghostwriter.",
          profile: {
            tone: ["direct", "high-conviction"],
            format_patterns: {
              sentence_rhythm: "Short, punchy sentences.",
              paragraphing: "One thought per paragraph.",
            },
            exemplars: ["Strong claims travel. Soft ones die in the feed."],
          },
        },
      },
      noModelFormatBlock: "Internal no-model LinkedIn format selected: Contrarian Reframe",
    })) {
      events.push(event);
    }

    const prompt = state.firstRoundMessages.map(messageText).join("\n\n");
    const artifacts = events.filter((event) => event.type === "artifact");
    const done = events.find((event) => event.type === "done");

    expect(prompt).toContain("VOICE PROFILE PRELOADED");
    expect(state.firstRoundTools).not.toContain("get_voice");
    expect(state.firstRoundTools).toContain("render_post");
    expect(state.streamCalls).toBe(1);
    expect(artifacts).toHaveLength(1);
    expect(done?.type === "done" ? done.message.content : "").not.toContain("Stopped before a response was produced.");
  });

  test("retries a slow invisible first round without reasoning", async () => {
    state.slowFirstDraftRound = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content: "Write an original post about why a personal brand compounds.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: {
          display_name: "Daniel Nogueira",
          summary: "Direct and practical.",
          profile: { tone: ["direct"] },
        },
      },
      noModelFormatBlock: "Internal no-model LinkedIn format selected: Single Insight",
      ordinaryDraftRoundTimeoutMs: 5,
    })) {
      events.push(event);
    }

    expect(state.streamCalls).toBe(2);
    expect(state.reasoningAttempts).toEqual([undefined, "none"]);
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
    expect(
      events.some(
        (event) => event.type === "done" && event.message.content.includes("Stopped before a response was produced."),
      ),
    ).toBe(false);
  });

  test("retries a transient first-round provider failure", async () => {
    state.failFirstDraftRound = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content: "Write one post about why reputation compounds.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: {
          display_name: "Daniel Nogueira",
          summary: "Direct and practical.",
          profile: { tone: ["direct"] },
        },
      },
      noModelFormatBlock: "Internal no-model LinkedIn format selected: Single Insight",
      ordinaryDraftRoundTimeoutMs: 100,
    })) {
      events.push(event);
    }

    expect(state.streamCalls).toBe(2);
    expect(state.reasoningAttempts).toEqual([undefined, "none"]);
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("never retries an explicit user abort", async () => {
    state.abortFirstDraftRound = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content: "Write one post about why reputation compounds.",
        },
      ],
      workspaceId: "workspace-1",
      signal: state.controller?.signal,
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: {
          display_name: "Daniel Nogueira",
          summary: "Direct and practical.",
          profile: { tone: ["direct"] },
        },
      },
      noModelFormatBlock:
        "Internal no-model LinkedIn format selected: Single Insight",
      ordinaryDraftRoundTimeoutMs: 100,
    })) {
      events.push(event);
    }

    expect(state.streamCalls).toBe(1);
    expect(state.reasoningAttempts).toEqual([undefined]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "done" && event.terminalReason === "cancelled",
      ),
    ).toBe(true);
  });
});
