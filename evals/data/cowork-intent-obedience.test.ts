import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "@/lib/agent/contracts";
import type { ChatMessage } from "@/lib/openrouter";

const IDEAS_PROMPT =
  "Give me exactly 3 distinct LinkedIn post ideas about why AI tools increase the value of judgment. For each idea include only: Hook, Core insight, and Proof/example. Do not write full posts. Do not search for sources. Return exactly 3 numbered items with no introduction or conclusion.";

const EXACT_IDEAS = [
  "1. Hook: AI makes execution cheap, so judgment becomes the bottleneck.\nCore insight: When everyone can produce, choosing what deserves to exist becomes the advantage.\nProof/example: Two teams use the same model; the team that rejects weak directions ships the stronger campaign.",
  "2. Hook: Better tools do not remove taste. They expose who has it.\nCore insight: Faster iteration creates more options, which makes selection quality more valuable.\nProof/example: A designer can generate 50 concepts in an hour, but still needs judgment to identify the one worth refining.",
  "3. Hook: AI scales your decisions, including the bad ones.\nCore insight: Automation multiplies the quality of the judgment upstream of it.\nProof/example: A precise positioning choice powers hundreds of useful assets; a vague one produces hundreds of forgettable assets.",
].join("\n\n");

const state = vi.hoisted(() => ({
  calls: [] as Array<{
    toolNames: string[];
    toolChoice: "auto" | "required" | "none" | undefined;
    glmReasoning: "high" | "none" | undefined;
  }>,
  failFirstTransiently: false,
  stallAfterPartialText: false,
  invalidPartialRounds: 0,
  exemplarCalls: 0,
  patternCalls: 0,
  freshnessCalls: 0,
  decisionCalls: 0,
  unsupportedPartialFirst: false,
}));

vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decideTurn: async () => {
    state.decisionCalls++;
    return { shouldAsk: false };
  },
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
    return { block: "", viralCount: 0, mediocreCount: 0 };
  },
}));

vi.mock("@/lib/batch/pattern-brief", () => ({
  getPatternBrief: async () => {
    state.patternCalls++;
    return null;
  },
  renderPatternBriefBlock: () => "",
}));

vi.mock("@/lib/agent/specialists/source-fidelity", () => ({
  reviewModeledDraft: async () => ({ pass: true, retryInstruction: "" }),
}));

vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/tools")>();
  return {
    ...actual,
    runTool: async (name: string) => {
      if (name === "get_top_from_batch") {
        return {
          ok: true,
          count: 1,
          posts: [
            {
              id: "f3b3a634-b710-4d36-851e-4469c8f0e65e",
              text: "A source post the user explicitly said not to search for.",
            },
          ],
          scrape: { window_days: 7 },
        };
      }
      return { ok: true };
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
      toolChoice?: "auto" | "required" | "none";
      glmReasoning?: "high" | "none";
      signal?: AbortSignal;
    }) => {
      const toolNames = (opts.tools ?? []).map((tool) => tool.function.name);
      state.calls.push({
        toolNames,
        toolChoice: opts.toolChoice,
        glmReasoning: opts.glmReasoning,
      });
      const round = state.calls.length;

      return (async function* () {
        if (round === 1 && state.failFirstTransiently) {
          const error = new Error("OpenRouter upstream unavailable");
          (error as Error & { code?: number }).code = 503;
          throw error;
        }
        if (round === 1 && state.stallAfterPartialText) {
          yield { text: "1. Hook: partial" };
          await new Promise<never>((_resolve, reject) => {
            const rejectAbort = () => {
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
        if (round <= state.invalidPartialRounds) {
          yield { text: EXACT_IDEAS.split("\n\n3. Hook:")[0] };
          yield { finishReason: "stop" as const };
          return;
        }
        if (round === 1 && state.unsupportedPartialFirst) {
          yield {
            text: EXACT_IDEAS.replace(
              "AI makes execution cheap, so judgment becomes the bottleneck.",
              "The best founders I write for know judgment is the bottleneck.",
            ),
          };
          yield { finishReason: "stop" as const };
          return;
        }
        // Replays the production failure: when discovery and post-render tools
        // are offered, the model follows those affordances even though the user
        // explicitly asked for no search and ideas rather than finished posts.
        if (round === 1 && toolNames.includes("get_top_from_batch")) {
          yield {
            toolCalls: [
              {
                index: 0,
                id: "call_search",
                name: "get_top_from_batch",
                argumentsFragment: JSON.stringify({ limit: 30 }),
              },
            ],
            finishReason: "tool_calls" as const,
          };
          return;
        }

        if (round === 2 && toolNames.includes("render_post")) {
          yield {
            toolCalls: [
              {
                index: 0,
                id: "call_render",
                name: "render_post",
                argumentsFragment: JSON.stringify({
                  body: "Everyone said AI would replace expertise. Here is idea #1 written as a full post instead.",
                  sourcePostId: "f3b3a634-b710-4d36-851e-4469c8f0e65e",
                }),
              },
            ],
            finishReason: "tool_calls" as const,
          };
          return;
        }

        yield { text: EXACT_IDEAS };
        yield { finishReason: "stop" as const };
      })();
    },
  };
});

const { runAgent } = await import("@/lib/agent");

beforeEach(() => {
  state.calls = [];
  state.failFirstTransiently = false;
  state.stallAfterPartialText = false;
  state.invalidPartialRounds = 0;
  state.exemplarCalls = 0;
  state.patternCalls = 0;
  state.freshnessCalls = 0;
  state.decisionCalls = 0;
  state.unsupportedPartialFirst = false;
});

describe("cowork intent obedience", () => {
  test("returns a no-search partial deliverable directly without source or post tools", async () => {
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      history: [{ role: "user", content: IDEAS_PROMPT }],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: {
        ok: true,
        voice: { summary: "Direct, specific, and concise." },
      },
    })) {
      events.push(event);
    }

    const firstCall = state.calls[0];
    const artifacts = events.filter((event) => event.type === "artifact");
    const toolStarts = events.filter((event) => event.type === "tool_start");
    const done = events.find((event) => event.type === "done");
    const finalContent = done?.type === "done" ? done.message.content : "";

    expect(firstCall.toolNames).not.toContain("get_top_from_batch");
    expect(firstCall.toolNames).not.toContain("search_viral_posts");
    expect(firstCall.toolNames).not.toContain("get_post");
    expect(firstCall.toolNames).not.toContain("render_cite");
    expect(firstCall.toolNames).not.toContain("render_post");
    expect(firstCall.toolChoice).toBe("none");
    expect(firstCall.glmReasoning).toBe("none");
    expect(state.calls).toHaveLength(1);
    expect(state.exemplarCalls).toBe(0);
    expect(state.patternCalls).toBe(0);
    expect(state.freshnessCalls).toBe(0);
    expect(state.decisionCalls).toBe(0);
    expect(toolStarts).toHaveLength(0);
    expect(artifacts).toHaveLength(0);
    expect(finalContent).toBe(EXACT_IDEAS);
  });

  test("corrects an invalid exact-count response before accepting it", async () => {
    state.invalidPartialRounds = 1;
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      history: [{ role: "user", content: IDEAS_PROMPT }],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: { ok: true, voice: { summary: "Direct." } },
      ordinaryDraftRoundTimeoutMs: 50,
    })) {
      events.push(event);
    }
    expect(state.calls).toHaveLength(2);
    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.message.content : "").toBe(EXACT_IDEAS);
    expect(
      events
        .filter((event): event is Extract<AgentEvent, { type: "text" }> =>
          event.type === "text",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe(EXACT_IDEAS);
  });

  test("does not accept or stream two consecutive invalid corrections", async () => {
    state.invalidPartialRounds = 2;
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      history: [{ role: "user", content: IDEAS_PROMPT }],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: { ok: true, voice: { summary: "Direct." } },
      ordinaryDraftRoundTimeoutMs: 50,
    })) {
      events.push(event);
    }
    expect(state.calls).toHaveLength(3);
    expect(
      events
        .filter((event): event is Extract<AgentEvent, { type: "text" }> =>
          event.type === "text",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe(EXACT_IDEAS);
  });

  test("honors curly-apostrophe no-post and no-source boundaries", async () => {
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      history: [
        {
          role: "user",
          content:
            "Give me exactly 3 post ideas. Don’t write full posts. Don’t use sources.",
        },
      ],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
    })) {
      events.push(event);
    }
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].toolNames).not.toContain("render_post");
    expect(state.calls[0].toolNames).not.toContain("search_news");
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(0);
  });

  test("retries a transient failure on the direct partial-text path", async () => {
    state.failFirstTransiently = true;
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      history: [{ role: "user", content: IDEAS_PROMPT }],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: { ok: true, voice: { summary: "Direct." } },
      ordinaryDraftRoundTimeoutMs: 50,
    })) {
      events.push(event);
    }
    expect(state.calls).toHaveLength(2);
    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.message.content : "").toBe(EXACT_IDEAS);
  });

  test("retries when a buffered partial answer emits text and then stalls", async () => {
    state.stallAfterPartialText = true;
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      history: [{ role: "user", content: IDEAS_PROMPT }],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      ordinaryDraftRoundTimeoutMs: 5,
    })) {
      events.push(event);
    }
    expect(state.calls).toHaveLength(2);
    expect(
      events
        .filter((event): event is Extract<AgentEvent, { type: "text" }> =>
          event.type === "text",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe(EXACT_IDEAS);
  });

  test("retries a structurally valid partial answer with an invented relationship", async () => {
    state.unsupportedPartialFirst = true;
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      history: [{ role: "user", content: IDEAS_PROMPT }],
      workspaceId: "workspace-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
    })) {
      events.push(event);
    }
    expect(state.calls).toHaveLength(2);
    expect(
      events
        .filter((event): event is Extract<AgentEvent, { type: "text" }> =>
          event.type === "text",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe(EXACT_IDEAS);
  });
});
