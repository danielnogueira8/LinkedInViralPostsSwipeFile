import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "@/lib/agent/contracts";
import { UsagePersistenceError } from "@/lib/openrouter";
import {
  runDraftEngine,
  type DraftEngineDependencies,
  type DraftEngineInput,
} from "@/lib/agent/draft-engine";
import {
  FALLBACK_DRAFT_WRITER_MODEL,
  PRIMARY_DRAFT_WRITER_MODEL,
  type DraftWriterAdapter,
  type DraftWriterRequest,
  type DraftWriterResponse,
} from "@/lib/agent/draft-writer";

const COMPLETE_POST = [
  "A useful reputation is career leverage you own.",
  "",
  "Your title can change overnight, but public proof keeps explaining how you think and what you can solve.",
  "",
  "Do the work. Share the lesson. Let trust compound before you need it.",
].join("\n");

const INCOMPLETE_POST = `${COMPLETE_POST}\n\nMost people pick`;

const REFINE_TARGET = {
  id: "draft-existing",
  kind: "post" as const,
  title: "Career leverage",
  body: COMPLETE_POST,
  media_attachments: [
    {
      id: "media-1",
      source: "zernio" as const,
      name: "image.png",
      size: 1024,
      type: "image" as const,
      mimeType: "image/png",
      url: "https://media.zernio.com/image.png",
      uploadedAt: "2026-07-14T12:00:00.000Z",
    },
  ],
  meta: { skills: ["storytelling"], source_url: "https://example.com/source" },
};

const usage = (input: number, output: number) => ({
  prompt_tokens: input,
  completion_tokens: output,
  total_tokens: input + output,
});

class ScriptedWriter implements DraftWriterAdapter {
  readonly requests: DraftWriterRequest[] = [];

  constructor(
    private readonly script: Array<
      | DraftWriterResponse
      | Error
      | ((request: DraftWriterRequest) => DraftWriterResponse | Promise<DraftWriterResponse>)
    >,
  ) {}

  async write(request: DraftWriterRequest): Promise<DraftWriterResponse> {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("writer script exhausted");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  }
}

function input(overrides: Partial<DraftEngineInput> = {}): DraftEngineInput {
  return {
    workspaceId: "ws-1",
    userInstruction:
      "Write an original post in my voice about why a personal brand is career leverage.",
    voiceResult: { ok: true, voice: { summary: "Direct and practical." } },
    preferences: [],
    feedbackMemory: [],
    priorPostDrafts: [],
    finalizerSpecialists: {
      edit: (body) => ({
        body,
        changed: false,
        usedModel: false,
        fixedCategories: [],
        notes: [],
      }),
      repairAiTells: async ({ body }) => ({
        body,
        repaired: false,
        detected: [],
      }),
      checkSameness: async ({ body }) => ({
        body,
        rewrote: false,
        overlapMarkers: [],
        reason: "",
      }),
      reviewSourceFidelity: async () => ({
        pass: true,
        reasons: [],
        retryInstruction: "",
      }),
    },
    ...overrides,
  };
}

async function collect(
  writer: ScriptedWriter,
  overrides: Partial<DraftEngineInput> = {},
  dependencyOverrides: Partial<DraftEngineDependencies> = {},
) {
  const recorded: Parameters<NonNullable<DraftEngineDependencies["recordUsage"]>>[] = [];
  const events: AgentEvent[] = [];
  for await (const event of runDraftEngine(input(overrides), {
    writer,
    recordUsage: vi.fn(async (
      ...args: Parameters<NonNullable<DraftEngineDependencies["recordUsage"]>>
    ) => {
      recorded.push(args);
    }),
    ...dependencyOverrides,
  })) {
    events.push(event);
  }
  return { events, recorded, writer };
}

function artifacts(events: AgentEvent[]) {
  return events
    .filter((event): event is Extract<AgentEvent, { type: "artifact" }> =>
      event.type === "artifact",
    )
    .map((event) => event.artifact);
}

function done(events: AgentEvent[]) {
  return events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
}

describe("DraftEngine", () => {
  test("accepts a primary Qwen draft with no tool-capable writer surface", async () => {
    const writer = new ScriptedWriter([
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(120, 80) },
    ]);
    const result = await collect(writer);

    expect(artifacts(result.events).map((artifact) => artifact.body)).toEqual([
      COMPLETE_POST,
    ]);
    expect(writer.requests).toHaveLength(1);
    expect(writer.requests[0]).toMatchObject({
      stage: "primary",
      model: PRIMARY_DRAFT_WRITER_MODEL,
      reasoning: "none",
    });
    expect(Object.keys(writer.requests[0])).not.toContain("tools");
    const prompt = JSON.stringify(writer.requests[0].messages);
    expect(prompt).not.toContain("get_voice");
    expect(prompt).not.toContain("render_post");
    expect(done(result.events)?.message).toMatchObject({
      inputTokens: 120,
      outputTokens: 80,
      tool_calls: null,
      toolMessages: [],
    });
    expect(result.recorded).toHaveLength(1);
  });

  test("repairs one rejected primary candidate before accepting it", async () => {
    const writer = new ScriptedWriter([
      { text: INCOMPLETE_POST, finishReason: "stop", usage: usage(100, 70) },
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(130, 75) },
    ]);
    const result = await collect(writer);

    expect(writer.requests.map((request) => request.stage)).toEqual([
      "primary",
      "repair",
    ]);
    expect(artifacts(result.events).map((artifact) => artifact.body)).toEqual([
      COMPLETE_POST,
    ]);
    expect(done(result.events)?.message).toMatchObject({
      inputTokens: 230,
      outputTokens: 145,
    });
  });

  test("refines one target in place and preserves its identity and metadata", async () => {
    const newHook = "Your title is rented. Your reputation is owned.";
    const modelRewrite = [
      newHook,
      "",
      "This entire model-written body must be discarded by the hook policy.",
      "",
      "Wrong CTA.",
    ].join("\n");
    const writer = new ScriptedWriter([
      { text: modelRewrite, finishReason: "stop", usage: usage(120, 80) },
    ]);
    const result = await collect(writer, {
      userInstruction: "Refine this post: Tighten the hook.",
      task: {
        kind: "refine",
        instruction: "Tighten the hook.",
        focus: "hook",
        target: REFINE_TARGET,
      },
    });

    expect(artifacts(result.events)).toEqual([
      {
        ...REFINE_TARGET,
        body: `${newHook}\n\nYour title can change overnight, but public proof keeps explaining how you think and what you can solve.\n\nDo the work. Share the lesson. Let trust compound before you need it.`,
      },
    ]);
    const prompt = JSON.stringify(writer.requests[0].messages);
    expect(prompt).toContain("CURRENT POST");
    expect(prompt).toContain("Return exactly one complete replacement post");
    expect(prompt).not.toContain("Vary the STRUCTURE of every from-scratch post");
    expect(prompt).not.toContain("render_post");
    expect(done(result.events)?.message.content).toContain("revised draft");
  });

  test("repairs an insufficient shorten before accepting one complete replacement", async () => {
    const target = {
      ...REFINE_TARGET,
      body: `${COMPLETE_POST}\n\n${"Useful public proof compounds over time. ".repeat(16)}`,
    };
    const accepted = `${COMPLETE_POST}\n\n${"Useful public proof compounds. ".repeat(6)}`;
    const writer = new ScriptedWriter([
      { text: target.body, finishReason: "stop", usage: usage(100, 70) },
      { text: accepted, finishReason: "stop", usage: usage(130, 75) },
    ]);
    const result = await collect(writer, {
      userInstruction: "Refine this post: Make it shorter.",
      task: {
        kind: "refine",
        instruction: "Make it shorter.",
        focus: "shorten",
        target,
      },
    });

    expect(writer.requests.map((request) => request.stage)).toEqual([
      "primary",
      "repair",
    ]);
    expect(artifacts(result.events)).toEqual([
      { ...target, body: accepted },
    ]);
  });

  test("accepts an explicit 10% trim without forcing the generic 15% repair", async () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, index) => `Proof paragraph ${index + 1} keeps the argument complete.`,
    );
    const target = {
      ...REFINE_TARGET,
      body: `${COMPLETE_POST}\n\n${paragraphs.join("\n\n")}`,
    };
    const accepted = `${COMPLETE_POST}\n\n${paragraphs.slice(0, 10).join("\n\n")}`;
    expect(accepted.length / target.body.length).toBeGreaterThan(0.85);
    expect(accepted.length / target.body.length).toBeLessThanOrEqual(0.9);
    const writer = new ScriptedWriter([
      { text: accepted, finishReason: "stop", usage: usage(100, 70) },
    ]);

    const result = await collect(writer, {
      userInstruction: "Refine this post: Make it 10% shorter.",
      task: {
        kind: "refine",
        instruction: "Make it 10% shorter.",
        focus: "shorten",
        target,
      },
    });

    expect(writer.requests.map((request) => request.stage)).toEqual(["primary"]);
    expect(artifacts(result.events)).toEqual([{ ...target, body: accepted }]);
  });

  test("leaves completeness slack for a 50% trim on a short post", async () => {
    const accepted = [
      "Public proof is portable career leverage.",
      "",
      "Share useful work before you need it. Let trust compound.",
    ].join("\n");
    expect(accepted.length / REFINE_TARGET.body.length).toBeLessThan(0.45);
    const writer = new ScriptedWriter([
      { text: accepted, finishReason: "stop", usage: usage(100, 50) },
    ]);

    const result = await collect(writer, {
      userInstruction: "Refine this post: Make it 50% shorter.",
      task: {
        kind: "refine",
        instruction: "Make it 50% shorter.",
        focus: "shorten",
        target: REFINE_TARGET,
      },
    });

    expect(writer.requests.map((request) => request.stage)).toEqual(["primary"]);
    expect(artifacts(result.events)).toEqual([
      { ...REFINE_TARGET, body: accepted },
    ]);
  });

  test("a cancelled refine emits no replacement artifact", async () => {
    const controller = new AbortController();
    const writer = new ScriptedWriter([
      () => {
        controller.abort();
        throw new DOMException("Stopped", "AbortError");
      },
    ]);
    const result = await collect(writer, {
      signal: controller.signal,
      userInstruction: "Refine this post: Make it shorter.",
      task: {
        kind: "refine",
        instruction: "Make it shorter.",
        focus: "shorten",
        target: REFINE_TARGET,
      },
    });

    expect(artifacts(result.events)).toHaveLength(0);
    expect(done(result.events)?.terminalReason).toBe("cancelled");
  });

  test("repairs a truncated primary candidate without presenting it", async () => {
    const partial = COMPLETE_POST.slice(0, -30);
    const writer = new ScriptedWriter([
      { text: partial, finishReason: "length", usage: usage(100, 40) },
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(125, 75) },
    ]);
    const result = await collect(writer);

    expect(writer.requests.map((request) => request.stage)).toEqual([
      "primary",
      "repair",
    ]);
    expect(JSON.stringify(result.events)).not.toContain(partial);
    expect(artifacts(result.events).map((artifact) => artifact.body)).toEqual([
      COMPLETE_POST,
    ]);
  });

  test("treats a content-filter stop as incomplete and repairs it", async () => {
    const partial = COMPLETE_POST.slice(0, -30);
    const writer = new ScriptedWriter([
      { text: partial, finishReason: "content_filter", usage: usage(100, 40) },
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(125, 75) },
    ]);
    const result = await collect(writer);

    expect(writer.requests.map((request) => request.stage)).toEqual([
      "primary",
      "repair",
    ]);
    expect(JSON.stringify(result.events)).not.toContain(partial);
    expect(artifacts(result.events).map((artifact) => artifact.body)).toEqual([
      COMPLETE_POST,
    ]);
  });

  test.each([
    ["timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["empty output", { text: "", finishReason: "stop", usage: usage(100, 0) }],
  ])("falls back to GLM after primary %s", async (_label, first) => {
    const writer = new ScriptedWriter([
      first as DraftWriterResponse | Error,
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(140, 80) },
    ]);
    const result = await collect(writer);

    expect(writer.requests.map(({ stage, model }) => ({ stage, model }))).toEqual([
      { stage: "primary", model: PRIMARY_DRAFT_WRITER_MODEL },
      { stage: "fallback", model: FALLBACK_DRAFT_WRITER_MODEL },
    ]);
    expect(artifacts(result.events)).toHaveLength(1);
  });

  test("uses GLM after the one repair is still rejected", async () => {
    const writer = new ScriptedWriter([
      { text: INCOMPLETE_POST, finishReason: "stop", usage: usage(100, 60) },
      { text: INCOMPLETE_POST, finishReason: "stop", usage: usage(110, 60) },
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(140, 80) },
    ]);
    const result = await collect(writer);

    expect(writer.requests.map((request) => request.stage)).toEqual([
      "primary",
      "repair",
      "fallback",
    ]);
    expect(JSON.stringify(writer.requests[2].messages)).toContain(
      "The draft was rejected by the server",
    );
    expect(artifacts(result.events)).toHaveLength(1);
  });

  test("both-writer failure ends in a persisted recoverable outcome, never a blank turn", async () => {
    const writer = new ScriptedWriter([
      new Error("primary unavailable"),
      new Error("fallback unavailable"),
    ]);
    const result = await collect(writer);

    expect(artifacts(result.events)).toHaveLength(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "draft_engine_exhausted",
        recovery: "continue",
      }),
    );
    expect(done(result.events)?.message.content.trim()).not.toBe("");
  });

  test("cancellation stops repair and fallback and persists a clean cancelled outcome", async () => {
    const controller = new AbortController();
    const writer = new ScriptedWriter([
      () => {
        controller.abort();
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      },
    ]);
    const result = await collect(writer, { signal: controller.signal });

    expect(writer.requests).toHaveLength(1);
    expect(artifacts(result.events)).toHaveLength(0);
    expect(done(result.events)).toMatchObject({
      terminalReason: "cancelled",
      message: { content: "Stopped before a draft was produced." },
    });
    expect(result.events.some((event) => event.type === "error")).toBe(false);
  });

  test("a usage persistence failure stops immediately without spending on fallback", async () => {
    const writer = new ScriptedWriter([
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(120, 80) },
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(140, 80) },
    ]);

    const consume = async () => {
      for await (const event of runDraftEngine(input(), {
        writer,
        recordUsage: vi.fn(async () => {
          throw new UsagePersistenceError("usage insert unavailable");
        }),
      })) {
        // The engine must throw before emitting or attempting another model.
        void event;
      }
    };

    await expect(consume()).rejects.toThrow("usage insert unavailable");
    expect(writer.requests).toHaveLength(1);
  });

  test("a stuck durable-cancellation read is bounded and cannot block drafting", async () => {
    const writer = new ScriptedWriter([
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(120, 80) },
    ]);
    const events: AgentEvent[] = [];

    for await (const event of runDraftEngine(
      input({ cancellationProbe: () => new Promise(() => {}) }),
      {
        writer,
        recordUsage: vi.fn(async () => undefined),
        cancelProbeTimeoutMs: 5,
      },
    )) {
      events.push(event);
    }

    expect(writer.requests).toHaveLength(1);
    expect(artifacts(events).map((artifact) => artifact.body)).toEqual([
      COMPLETE_POST,
    ]);
  });

  test("aborts a timed-out cancellation read instead of leaving it pending", async () => {
    const writer = new ScriptedWriter([
      { text: COMPLETE_POST, finishReason: "stop", usage: usage(120, 80) },
    ]);
    let probeAborted = false;

    await collect(writer, {
      cancellationProbe: (signal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              probeAborted = true;
              resolve(false);
            },
            { once: true },
          );
        }),
    }, {
      cancelProbeTimeoutMs: 5,
    });

    expect(probeAborted).toBe(true);
  });

  test("observes a late durable Stop with at most one cancellation read in flight", async () => {
    let active = 0;
    let maxActive = 0;
    let probeCalls = 0;
    const writer = new ScriptedWriter([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return {
          text: COMPLETE_POST,
          finishReason: "stop",
          usage: usage(120, 80),
        };
      },
    ]);
    const events: AgentEvent[] = [];

    for await (const event of runDraftEngine(
      input({
        cancellationProbe: (signal) =>
          new Promise<boolean>((resolve) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            const call = ++probeCalls;
            let settled = false;
            const settle = (value: boolean) => {
              if (settled) return;
              settled = true;
              active -= 1;
              resolve(value);
            };
            const timer = setTimeout(() => settle(call >= 2), 20);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                settle(false);
              },
              { once: true },
            );
          }),
      }),
      {
        writer,
        recordUsage: vi.fn(async () => undefined),
        cancelPollMs: 1,
        cancelProbeTimeoutMs: 100,
      },
    )) {
      events.push(event);
    }

    expect(maxActive).toBe(1);
    expect(probeCalls).toBeGreaterThanOrEqual(2);
    expect(artifacts(events)).toHaveLength(0);
    expect(done(events)?.terminalReason).toBe("cancelled");
  });
});
