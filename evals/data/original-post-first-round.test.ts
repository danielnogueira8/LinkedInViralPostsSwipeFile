import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "@/lib/agent/contracts";
import type { ChatMessage } from "@/lib/openrouter";

const SOURCE_POST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const state = vi.hoisted(() => ({
  controller: null as AbortController | null,
  streamCalls: 0,
  firstRoundMessages: [] as ChatMessage[],
  firstRoundTools: [] as string[],
  firstRoundRenderParameters: null as Record<string, unknown> | null,
  slowFirstDraftRound: false,
  failFirstDraftRound: false,
  abortFirstDraftRound: false,
  allowToolFollowup: false,
  firstDraftRoundDelayMs: 0,
  draftBodies: [] as string[],
  reasoningAttempts: [] as Array<"high" | "none" | undefined>,
  renderBeforeVoiceSameRound: false,
  freshnessCalls: 0,
  exemplarCalls: 0,
  patternCalls: 0,
  sourceReasoningLeak: false,
  emptySourceSearch: false,
}));

vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decideTurn: async () => ({ shouldAsk: false }),
}));

vi.mock("@/lib/agent/specialists/freshness", () => ({
  computeFreshnessConstraint: async () => {
    state.freshnessCalls++;
    return { block: "", markers: [] };
  },
}));

vi.mock("@/lib/batch/exemplar-retrieval", () => ({
  buildExemplarBlock: async () => {
    state.exemplarCalls++;
    return {
      block: "",
      viralCount: 0,
      mediocreCount: 0,
    };
  },
}));

vi.mock("@/lib/batch/pattern-brief", () => ({
  getPatternBrief: async () => {
    state.patternCalls++;
    return null;
  },
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
            backstory_guidance: "Daniel built three companies.",
          },
        };
      }
      if (name === "search_viral_posts") {
        if (state.emptySourceSearch) {
          return { ok: true, count: 0, posts: [] };
        }
        return {
          ok: true,
          count: 1,
          posts: [
            {
              id: SOURCE_POST_ID,
              text: "A verified source post with a crisp contrarian structure.",
            },
          ],
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
      tools?: Array<{
        function: { name: string; parameters: Record<string, unknown> };
      }>;
      signal?: AbortSignal;
      glmReasoning?: "high" | "none";
    }) => {
      state.streamCalls++;
      state.reasoningAttempts.push(opts.glmReasoning);
      const toolNames = (opts.tools ?? []).map((tool) => tool.function.name);
      if (state.streamCalls === 1) {
        state.firstRoundMessages = opts.messages;
        state.firstRoundTools = toolNames;
        state.firstRoundRenderParameters =
          opts.tools?.find((tool) => tool.function.name === "render_post")
            ?.function.parameters ?? null;
      }

      return (async function* () {
        if (state.streamCalls === 1 && state.renderBeforeVoiceSameRound) {
          yield {
            toolCalls: [
              {
                index: 0,
                id: "call_render_first",
                name: "render_post",
                argumentsFragment: JSON.stringify({
                  body:
                    "I built three companies.\n\nDistribution compounds because every useful post keeps introducing the work to new people.",
                }),
              },
              {
                index: 1,
                id: "call_voice_second",
                name: "get_voice",
                argumentsFragment: "{}",
              },
            ],
            finishReason: "tool_calls" as const,
          };
          return;
        }
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

        if (
          state.controller?.signal.aborted ||
          (!state.allowToolFollowup &&
            opts.messages.some((message) => message.role === "tool"))
        ) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }

        if (state.renderBeforeVoiceSameRound) {
          yield { text: "Done." };
          yield { finishReason: "stop" as const };
          return;
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

        if (state.firstDraftRoundDelayMs > 0 && state.streamCalls === 1) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, state.firstDraftRoundDelayMs);
            const rejectAbort = () => {
              clearTimeout(timer);
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (opts.signal?.aborted) rejectAbort();
            else opts.signal?.addEventListener("abort", rejectAbort, {
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

        if (state.sourceReasoningLeak && state.streamCalls === 1) {
          yield {
            text:
              "I'll search your swipe file first.</think>I'll search your swipe file first.</think>",
          };
          yield { finishReason: "stop" as const };
          return;
        }

        const directSourceTurn = opts.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            /top-performing regular post/i.test(message.content),
        );
        const hasVerifiedSource = opts.messages.some(
          (message) =>
            message.role === "tool" &&
            typeof message.content === "string" &&
            message.content.includes(SOURCE_POST_ID),
        );
        if (directSourceTurn && !hasVerifiedSource) {
          yield {
            toolCalls: [
              {
                index: 0,
                id: "call_source",
                name: "search_viral_posts",
                argumentsFragment: JSON.stringify({ limit: 1 }),
              },
            ],
            finishReason: "tool_calls" as const,
          };
          return;
        }

        const defaultBody = [
          "Your personal brand is career leverage you own.",
          "",
          "A job title disappears when you leave.",
          "A reputation follows you into every room.",
          "",
          "Each useful post compounds into trust, introductions, and opportunities you can carry between roles.",
          "",
          "Build the asset before you need it.",
        ].join("\n");
        yield {
          toolCalls: [
            {
              index: 0,
              id: "call_render",
              name: "render_post",
              argumentsFragment: JSON.stringify({
                body: state.draftBodies[state.streamCalls - 1] ?? defaultBody,
                ...(directSourceTurn
                  ? { sourcePostId: SOURCE_POST_ID }
                  : {}),
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
  state.firstRoundRenderParameters = null;
  state.slowFirstDraftRound = false;
  state.failFirstDraftRound = false;
  state.abortFirstDraftRound = false;
  state.allowToolFollowup = false;
  state.firstDraftRoundDelayMs = 0;
  state.draftBodies = [];
  state.reasoningAttempts = [];
  state.renderBeforeVoiceSameRound = false;
  state.freshnessCalls = 0;
  state.exemplarCalls = 0;
  state.patternCalls = 0;
  state.sourceReasoningLeak = false;
  state.emptySourceSearch = false;
});

describe("ordinary original-post first-round delivery", () => {
  test("prefetches a verified source before the model is asked to render", async () => {
    state.allowToolFollowup = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Find one top-performing regular post in my swipe file and model its structure into an original LinkedIn post in my voice about publishing early.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: { summary: "Direct and practical." },
      },
    })) {
      events.push(event);
    }

    const firstPrompt = state.firstRoundMessages
      .map((message) =>
        typeof message.content === "string" ? message.content : "",
      )
      .join("\n");
    const toolStarts = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_start" }> =>
        event.type === "tool_start",
    );

    expect(firstPrompt).toContain(SOURCE_POST_ID);
    expect(firstPrompt).toContain(
      "Do not transplant, remix, or invent personal anecdotes",
    );
    expect(state.firstRoundTools).toEqual(["render_post"]);
    expect(state.firstRoundRenderParameters).toMatchObject({
      required: ["body", "sourcePostId"],
      properties: {
        body: { minLength: 180 },
        sourcePostId: { enum: [SOURCE_POST_ID] },
      },
    });
    const renderProperties =
      (state.firstRoundRenderParameters?.properties as
        | Record<string, { description?: string }>
        | undefined) ?? {};
    expect(renderProperties.body?.description).toMatch(
      /zero unsupported first-person observations/i,
    );
    expect(toolStarts.map((event) => event.name)).toEqual([
      "search_viral_posts",
      "render_post",
    ]);
    expect(state.streamCalls).toBe(1);
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
  });

  test("rejects a fabricated progressive anecdote on the direct source path", async () => {
    state.allowToolFollowup = true;
    state.draftBodies = [
      '6 months ago, I was talking to a founder who had been "almost ready" to launch for a year. Today, they have clients sliding into their DMs.',
      "Publishing before the product feels ready creates a useful feedback loop.\n\nReal reactions show founders which rough edges matter and which ones only feel important from inside the build.\n\nEarly attention also tests whether the promise is clear before more time goes into polishing the wrong details.",
    ];
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Find one top-performing regular post in my swipe file and model its structure into an original LinkedIn post in my voice about publishing early.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: {
          summary: "A direct, practical 6-year ghostwriter for founders.",
          profile: {
            exemplars: [
              '6 months ago, I was talking to a founder who had been "almost ready" to launch for a year.',
            ],
          },
          backstory_guidance:
            "Verified backstory: 6 years experience as a LinkedIn ghostwriter for founders.",
        },
      },
    })) {
      events.push(event);
    }

    const artifacts = events.filter(
      (event): event is Extract<AgentEvent, { type: "artifact" }> =>
        event.type === "artifact",
    );
    expect(state.streamCalls).toBe(2);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.body).not.toContain("I was talking to a founder");
    expect(artifacts[0].artifact.body).toContain("useful feedback loop");
  });

  test("rejects a source-hook fragment when the user requested a full post", async () => {
    state.allowToolFollowup = true;
    state.draftBodies = [
      "I successfully broke every rule that says wait until your product feels ready before you talk about it publicly.",
      [
        "A product does not need to feel finished before its ideas are worth publishing.",
        "",
        "Publishing early creates a feedback loop. Real reactions reveal which rough edges matter, which promises resonate, and which assumptions only sounded convincing inside the build.",
        "",
        "The point is not to pretend the product is polished. The point is to let the market help shape what deserves polishing next.",
        "",
        "Ship the useful idea before every detail feels safe.",
      ].join("\n"),
    ];
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Find one top-performing regular post in my swipe file and model its structure into an original LinkedIn post in my voice about publishing early.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: { summary: "Direct and practical." },
      },
    })) {
      events.push(event);
    }

    const artifacts = events.filter(
      (event): event is Extract<AgentEvent, { type: "artifact" }> =>
        event.type === "artifact",
    );
    expect(state.streamCalls).toBe(2);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.body).not.toContain("successfully broke");
    expect(artifacts[0].artifact.body.length).toBeGreaterThanOrEqual(180);
  });

  test("fails closed without spending a model round when source prefetch is empty", async () => {
    state.emptySourceSearch = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Find one top-performing regular post in my swipe file and model its structure into an original LinkedIn post in my voice about publishing early.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: { summary: "Direct and practical." },
      },
    })) {
      events.push(event);
    }

    const error = events.find(
      (event): event is Extract<AgentEvent, { type: "error" }> =>
        event.type === "error",
    );
    const done = events.find(
      (event): event is Extract<AgentEvent, { type: "done" }> =>
        event.type === "done",
    );

    expect(state.streamCalls).toBe(0);
    expect(error?.code).toBe("source_modeling_incomplete");
    expect(done?.message.content).toContain("couldn't find a verified source");
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(0);
  });

  test("processes voice grounding before a same-round render regardless of call order", async () => {
    state.renderBeforeVoiceSameRound = true;
    state.allowToolFollowup = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content: "Write a LinkedIn post in my voice about distribution.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
    })) {
      events.push(event);
    }

    const artifacts = events.filter(
      (event): event is Extract<AgentEvent, { type: "artifact" }> =>
        event.type === "artifact",
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.body).toContain("I built three companies");
  });

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

  test("turns a clarification answer directly into a draft without research or another ask", async () => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      history: [
        { role: "user", content: "Help me write a LinkedIn post." },
        {
          role: "assistant",
          content: "What should the post be about?",
          tool_calls: [
            {
              id: "ask-topic",
              type: "function",
              function: {
                name: "ask_user",
                arguments:
                  '{"question":"What should the post be about?","options":["Share the topic","You choose"]}',
              },
            },
          ],
        },
        { role: "user", content: "An AI-assisted content workflow post" },
      ],
      userInstruction:
        "Help me write a LinkedIn post.\n\nClarification answer: An AI-assisted content workflow post",
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: { summary: "Direct and practical." },
      },
    })) {
      events.push(event);
    }

    const firstPrompt = state.firstRoundMessages
      .map((message) =>
        typeof message.content === "string" ? message.content : "",
      )
      .join("\n");
    expect(state.firstRoundTools).toEqual(["render_post"]);
    expect(firstPrompt).toMatch(/clarification answer received/i);
    expect(
      events.some(
        (event) =>
          event.type === "tool_start" &&
          ["get_top_from_batch", "list_niches", "search_viral_posts"].includes(
            event.name,
          ),
      ),
    ).toBe(false);
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
  });

  test("rejects a draft outside the user's explicit character range", async () => {
    state.allowToolFollowup = true;
    state.draftBodies = [
      `This draft is too long. ${"x".repeat(1_020)}`,
      `Distribution compounds when good judgment reaches more people. ${"Clear direction turns each useful idea into another opportunity to earn attention. ".repeat(9)}`,
    ];
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Write an original LinkedIn post in my voice about why distribution compounds faster than product quality. Make it 700–1,000 characters, include one concrete example, no em dashes, no hashtags, and end with a sharp one-sentence takeaway.",
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
    })) {
      events.push(event);
    }

    const artifacts = events.filter(
      (event): event is Extract<AgentEvent, { type: "artifact" }> =>
        event.type === "artifact",
    );

    expect(state.streamCalls).toBe(2);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.body.length).toBeGreaterThanOrEqual(700);
    expect(artifacts[0].artifact.body.length).toBeLessThanOrEqual(1_000);
  });

  test("rejects an unsupported first-person anecdote before rendering", async () => {
    state.allowToolFollowup = true;
    state.draftBodies = [
      `I watched this play out with two ghostwriters I know. One spent six months perfecting delivery while the other posted every day and built a larger client roster. ${"The lesson looked obvious once the outcomes separated. ".repeat(8)}`,
      `Distribution makes judgment visible, repeatable, and easier to trust. ${"A useful idea creates more leverage each time the right audience sees it and acts on it. ".repeat(8)}`,
    ];
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Write an original LinkedIn post in my voice about why distribution compounds faster than product quality. Do not model it after a source post.",
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
    })) {
      events.push(event);
    }

    const artifacts = events.filter(
      (event): event is Extract<AgentEvent, { type: "artifact" }> =>
        event.type === "artifact",
    );

    expect(state.streamCalls).toBe(2);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact.body).not.toContain("I watched this play out");
    expect(artifacts[0].artifact.body).not.toContain("ghostwriters I know");
  });

  test("keeps direct source modeling focused and retries a silent first round", async () => {
    state.firstDraftRoundDelayMs = 25;
    state.allowToolFollowup = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Find one top-performing regular post in my swipe file and model its structure into an original LinkedIn post in my voice about why founders should publish before their product feels ready.",
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
      ordinaryDraftRoundTimeoutMs: 5,
    })) {
      events.push(event);
    }

    expect(state.streamCalls).toBe(2);
    expect(state.reasoningAttempts).toEqual(["none", "none"]);
    expect(state.firstRoundTools).toEqual(["render_post"]);
    expect(state.freshnessCalls).toBe(0);
    expect(state.exemplarCalls).toBe(0);
    expect(state.patternCalls).toBe(0);
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
  });

  test("retries a transient first-round failure for direct source modeling", async () => {
    state.failFirstDraftRound = true;
    state.allowToolFollowup = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Find one top-performing regular post in my swipe file and model its structure into an original LinkedIn post in my voice about publishing early.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: { summary: "Direct and practical." },
      },
      ordinaryDraftRoundTimeoutMs: 100,
    })) {
      events.push(event);
    }

    expect(state.streamCalls).toBe(2);
    expect(state.reasoningAttempts).toEqual(["none", "none"]);
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
  });

  test("never exposes provider reasoning tags on direct source modeling", async () => {
    state.sourceReasoningLeak = true;
    state.allowToolFollowup = true;
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Find one top-performing regular post in my swipe file and model its structure into an original LinkedIn post in my voice about publishing early.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: { summary: "Direct and practical." },
      },
      ordinaryDraftRoundTimeoutMs: 100,
    })) {
      events.push(event);
    }

    const visibleText = events
      .filter(
        (event): event is Extract<AgentEvent, { type: "text" }> =>
          event.type === "text",
      )
      .map((event) => event.delta)
      .join("");
    expect(visibleText).not.toContain("think>");
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
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
