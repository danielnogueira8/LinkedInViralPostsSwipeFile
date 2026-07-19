import { describe, expect, test, vi } from "vitest";
import type { Artifact } from "@/lib/agent/contracts";
import {
  executeModeledDraftBatch,
  type AcquiredModeledDraftBatch,
  type ExecuteModeledDraftBatchInput,
  type ModeledDraftBatchAcquireResult,
  type ModeledDraftBatchRepository,
  type ModeledDraftBatchSource,
  type ModeledPostArtifact,
  type ModeledDraftSlotCheckpoint,
} from "@/lib/agent/modeled-draft-batch";
import type {
  ModeledDraftSlotInput,
  ModeledDraftSlotOutcome,
} from "@/lib/agent/modeled-draft-slot-runner";
import { UsagePersistenceError } from "@/lib/openrouter";

const sources: ModeledDraftBatchSource[] = [
  "launch",
  "project",
  "community",
  "system",
  "positioning",
  "distribution",
  "research",
  "strategy",
].map((topic, index) => ({
  id: `source-${index + 1}`,
  url: `https://linkedin.com/posts/source-${index + 1}`,
  text: [
    `A strong ${topic} starts with one clear promise people can understand.`,
    "The middle develops that promise through concrete observations and a useful progression.",
    "The ending turns the same idea into one practical decision for the reader.",
  ].join("\n\n"),
}));

function taggedArtifact(
  slotIndex: number,
  source: ModeledDraftSlotInput["source"],
  body: string,
): Artifact & { kind: "post" } {
  return {
    id: `artifact-${slotIndex}-${source.id}`,
    kind: "post",
    title: body.split("\n", 1)[0],
    body,
    meta: {
      modeled_draft_slot_id: `batch-1:slot-${slotIndex}`,
      modeled_draft_slot_index: slotIndex,
      source: "model_source",
      source_post_id: source.id,
      source_url: source.url,
      research_provenance: {
        route: "workspace_research",
        sources: [
          {
            id: source.id,
            kind: "workspace_post",
            url: source.url,
          },
        ],
      },
    },
  };
}

class MemoryRepository implements ModeledDraftBatchRepository {
  readonly batchId = "batch-1";
  readonly leaseToken = "lease-1";
  private requestHash: string | null = null;
  private requestedCount = 0;
  private sourcePool: ModeledDraftBatchSource[] = [];
  private status: "running" | "incomplete" | "complete" = "running";
  private slots: ModeledDraftSlotCheckpoint[] = [];
  private leased = false;
  acceptFailure: { slotIndex: number; mode: "false" | "throw" } | null = null;
  replaceFailure: {
    slotIndex: number;
    mode: "false" | "throw" | "hang";
  } | null = null;
  completeFailure: "incomplete" | "lease_lost" | "throw" | null = null;

  async acquire(input: Parameters<ModeledDraftBatchRepository["acquire"]>[0]) {
    if (this.requestHash && this.requestHash !== input.requestHash) {
      return { kind: "conflict" as const };
    }
    if (!this.requestHash) {
      this.requestHash = input.requestHash;
      this.requestedCount = input.requestedCount;
      this.sourcePool = [...input.sources];
      this.slots = Array.from({ length: input.requestedCount }, (_, index) => ({
        index,
        state: "assigned" as const,
        sourceIndex: index,
        sourceHistory: [index],
        replacements: 0,
      }));
    }
    const checkpoint: AcquiredModeledDraftBatch = {
      batchId: this.batchId,
      leaseToken: this.leaseToken,
      requestHash: this.requestHash,
      requestedCount: this.requestedCount,
      sources: [...this.sourcePool],
      slots: this.slots.map((slot) => ({ ...slot })),
    };
    if (this.status === "complete") {
      return {
        kind: "complete" as const,
        batchId: this.batchId,
        artifacts: this.slots.flatMap((slot) =>
          slot.state === "accepted" && slot.artifact ? [slot.artifact] : [],
        ),
      };
    }
    if (this.leased) {
      return { kind: "busy" as const, batchId: this.batchId };
    }
    this.leased = true;
    this.status = "running";
    return { kind: "acquired" as const, checkpoint };
  }

  async acceptSlot(
    input: Parameters<ModeledDraftBatchRepository["acceptSlot"]>[0],
  ) {
    if (this.acceptFailure?.slotIndex === input.slotIndex) {
      if (this.acceptFailure.mode === "throw") {
        throw new Error("accept failed");
      }
      return false;
    }
    const slot = this.slots[input.slotIndex];
    if (!slot || slot.state === "accepted") return false;
    this.slots[input.slotIndex] = {
      ...slot,
      state: "accepted",
      artifact: input.artifact,
    };
    return true;
  }

  async replaceSlotSource(
    input: Parameters<ModeledDraftBatchRepository["replaceSlotSource"]>[0],
  ) {
    if (this.replaceFailure?.slotIndex === input.slotIndex) {
      if (this.replaceFailure.mode === "throw") {
        throw new Error("replace failed");
      }
      if (this.replaceFailure.mode === "hang") {
        return new Promise<boolean>(() => {});
      }
      return false;
    }
    const slot = this.slots[input.slotIndex];
    if (!slot || slot.state === "accepted") return false;
    this.slots[input.slotIndex] = {
      ...slot,
      state: "assigned",
      sourceIndex: input.sourceIndex,
      sourceHistory: [...slot.sourceHistory, input.sourceIndex],
      replacements: slot.replacements + 1,
      lastFailureCode: input.failureCode,
    };
    return true;
  }

  async complete() {
    if (this.completeFailure === "throw") {
      throw new Error("complete failed");
    }
    if (this.completeFailure === "incomplete") {
      return { kind: "incomplete" as const };
    }
    if (this.completeFailure === "lease_lost") {
      return { kind: "lease_lost" as const };
    }
    const artifacts = this.slots.flatMap((slot) =>
      slot.state === "accepted" && slot.artifact ? [slot.artifact] : [],
    );
    if (artifacts.length !== this.requestedCount) {
      return { kind: "incomplete" as const };
    }
    this.status = "complete";
    this.leased = false;
    return { kind: "complete" as const, artifacts };
  }

  async release() {
    this.status = "incomplete";
    this.leased = false;
  }
}

const engineInput: ExecuteModeledDraftBatchInput["engineInput"] = {
  workspaceId: "workspace-1",
  userInstruction:
    "Find 3 top-performing regular posts and rewrite each in my voice.",
  voiceResult: { ok: true },
  preferences: [],
  feedbackMemory: [],
  priorPostDrafts: [],
};

function batchInput(
  overrides: Partial<ExecuteModeledDraftBatchInput> = {},
): ExecuteModeledDraftBatchInput {
  return {
    operationKey: "root-user-message-1",
    workspaceId: "workspace-1",
    instruction:
      "Find 3 top-performing regular posts and rewrite each in my voice.",
    count: 3,
    sources: sources.slice(0, 4),
    engineInput,
    ...overrides,
  };
}

const distinctBodies = [
  [
    "A reputation becomes useful when other people can explain what you do.",
    "Specific observations and repeated proof make that understanding portable beyond a single conversation.",
    "Publish the evidence that helps the right buyer remember your judgment.",
  ].join("\n\n"),
  [
    "A writing system should remove decisions before the blank page appears.",
    "Choose the audience problem, central argument, and publishing constraint before drafting the first sentence.",
    "Spend the saved attention sharpening the idea instead of rebuilding the process.",
  ].join("\n\n"),
  [
    "An audience compounds when every post gives the right reader a reason to return.",
    "Useful distinctions create trust because they help people see familiar work with better language and clearer choices.",
    "Optimize for the next relevant conversation, not the loudest immediate reaction.",
  ].join("\n\n"),
  [
    "Good positioning removes categories that distract the buyer from the real decision.",
    "A narrow promise, credible proof, and a clear contrast make the intended choice easier to recognize.",
    "Name the tradeoff your best customers already understand.",
  ].join("\n\n"),
  [
    "Distribution improves when an idea is designed to travel between useful conversations.",
    "Memorable language gives readers a compact way to carry the lesson into meetings, messages, and decisions.",
    "Write for the person who will repeat the point tomorrow.",
  ].join("\n\n"),
];

function successfulSlotRunner() {
  return vi.fn(async (input: ModeledDraftSlotInput) =>
    accepted(input, distinctBodies[input.slot.index]),
  );
}

function acquireOnlyRepository(
  result: ModeledDraftBatchAcquireResult,
): ModeledDraftBatchRepository {
  return {
    acquire: vi.fn(async () => result),
    acceptSlot: vi.fn(async () => false),
    replaceSlotSource: vi.fn(async () => false),
    complete: vi.fn(async () => ({ kind: "incomplete" as const })),
    release: vi.fn(async () => {}),
  };
}

function corruptProvenance(
  artifact: ModeledPostArtifact,
  field: "slot" | "source",
): ModeledPostArtifact {
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      ...(field === "slot"
        ? { modeled_draft_slot_id: "batch-1:slot-99" }
        : { source_post_id: "wrong-source" }),
    },
  };
}

function accepted(
  input: ModeledDraftSlotInput,
  body: string,
): Extract<ModeledDraftSlotOutcome, { kind: "accepted" }> {
  return {
    kind: "accepted",
    slot: input.slot,
    artifact: taggedArtifact(input.slot.index, input.source, body),
    inputTokens: 100,
    outputTokens: 50,
  };
}

describe("executeModeledDraftBatch", () => {
  test.each([
    ["a count below the batch minimum", { count: 1, sources: sources.slice(0, 1) }],
    ["a count above the batch maximum", { count: 6, sources: sources.slice(0, 6) }],
    ["a non-integer count", { count: 2.5, sources: sources.slice(0, 3) }],
    [
      "duplicate source ids",
      {
        count: 2,
        sources: [sources[0], { ...sources[1], id: sources[0].id }],
      },
    ],
    [
      "an empty source id",
      { count: 2, sources: [{ ...sources[0], id: "" }, sources[1]] },
    ],
    [
      "an empty source body",
      { count: 2, sources: [{ ...sources[0], text: "" }, sources[1]] },
    ],
    [
      "a source without a resolvable chip URL",
      {
        count: 2,
        sources: [
          { ...sources[0], url: undefined },
          sources[1],
        ] as unknown as ModeledDraftBatchSource[],
      },
    ],
    [
      "a malformed source URL that only resembles an absolute URL",
      {
        count: 2,
        sources: [{ ...sources[0], url: "https://" }, sources[1]],
      },
    ],
  ] as const)(
    "rejects %s before repository acquisition or writing",
    async (_name, overrides) => {
      const repository = new MemoryRepository();
      const acquire = vi.spyOn(repository, "acquire");
      const runSlot = successfulSlotRunner();

      const result = await executeModeledDraftBatch(
        batchInput(overrides),
        { repository, runSlot, now: () => 1_000 },
      );

      expect(result).toMatchObject({
        kind: "failed",
        reason: "invalid_request",
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(runSlot).not.toHaveBeenCalled();
    },
  );

  test("lets storage distinguish a new sparse request from a resumable frozen batch", async () => {
    const repository = acquireOnlyRepository({ kind: "insufficient_sources" });
    const runSlot = successfulSlotRunner();

    const result = await executeModeledDraftBatch(
      batchInput({ count: 3, sources: sources.slice(0, 2) }),
      { repository, runSlot, now: () => 1_000 },
    );

    expect(result).toMatchObject({
      kind: "failed",
      reason: "insufficient_sources",
    });
    expect(repository.acquire).toHaveBeenCalledOnce();
    expect(runSlot).not.toHaveBeenCalled();
  });

  test("resumes the frozen pool without depending on current discovery", async () => {
    const repository = new MemoryRepository();
    const firstRunner = vi.fn(async (input: ModeledDraftSlotInput) =>
      input.slot.index === 0
        ? accepted(input, distinctBodies[0])
        : {
            kind: "reviewer_unavailable" as const,
            slot: input.slot,
            inputTokens: 10,
            outputTokens: 5,
          },
    );
    const original = batchInput({ count: 2, sources: sources.slice(0, 3) });

    await expect(
      executeModeledDraftBatch(original, {
        repository,
        runSlot: firstRunner,
        now: () => 1_000,
      }),
    ).resolves.toMatchObject({
      kind: "incomplete",
      preservedSlots: 1,
      preservedArtifacts: [{ id: "artifact-0-source-1" }],
    });

    const retryRunner = successfulSlotRunner();
    const retry = await executeModeledDraftBatch(
      { ...original, sources: [] },
      { repository, runSlot: retryRunner, now: () => 2_000 },
    );

    expect(retry).toMatchObject({ kind: "complete", batchId: "batch-1" });
    expect(retryRunner).toHaveBeenCalledOnce();
    expect(retryRunner.mock.calls[0][0]).toMatchObject({
      slot: { index: 1 },
      source: { id: "source-2" },
    });
  });

  test("replays an exact completed batch without another writer call", async () => {
    const repository = new MemoryRepository();
    const runSlot = successfulSlotRunner();
    const input = batchInput({ count: 2, sources: sources.slice(0, 2) });

    const first = await executeModeledDraftBatch(input, {
      repository,
      runSlot,
      now: () => 1_000,
    });
    expect(first.kind).toBe("complete");
    expect(runSlot).toHaveBeenCalledTimes(2);

    runSlot.mockClear();
    const replay = await executeModeledDraftBatch(input, {
      repository,
      runSlot,
      now: () => 2_000,
    });

    expect(replay).toMatchObject({ kind: "complete", batchId: "batch-1" });
    expect(replay.kind === "complete" ? replay.artifacts : []).toHaveLength(2);
    expect(runSlot).not.toHaveBeenCalled();
  });

  test("reuses the frozen source contract when retry discovery rotates", async () => {
    const repository = new MemoryRepository();
    const runSlot = successfulSlotRunner();
    const original = batchInput({ count: 2, sources: sources.slice(0, 2) });
    expect(
      (await executeModeledDraftBatch(original, {
        repository,
        runSlot,
        now: () => 1_000,
      })).kind,
    ).toBe("complete");

    runSlot.mockClear();
    const replay = await executeModeledDraftBatch(
      batchInput({ count: 2, sources: [sources[0], sources[2]] }),
      { repository, runSlot, now: () => 2_000 },
    );

    expect(replay).toMatchObject({ kind: "complete", batchId: "batch-1" });
    expect(
      replay.kind === "complete"
        ? replay.artifacts.map((artifact) => artifact.meta?.source_post_id)
        : [],
    ).toEqual(["source-1", "source-2"]);
    expect(runSlot).not.toHaveBeenCalled();
  });

  test("rejects a retry whose semantic generation context changed", async () => {
    const repository = new MemoryRepository();
    const firstRunner = vi.fn(async (input: ModeledDraftSlotInput) =>
      input.slot.index === 0
        ? accepted(input, distinctBodies[0])
        : {
            kind: "reviewer_unavailable" as const,
            slot: input.slot,
            inputTokens: 20,
            outputTokens: 10,
          },
    );
    const original = batchInput({ count: 2, sources: sources.slice(0, 2) });

    expect(
      await executeModeledDraftBatch(original, {
        repository,
        runSlot: firstRunner,
        now: () => 1_000,
      }),
    ).toMatchObject({
      kind: "incomplete",
      reason: "reviewer_unavailable",
      preservedSlots: 1,
    });

    const retryRunner = successfulSlotRunner();
    const retry = await executeModeledDraftBatch(
      {
        ...original,
        engineInput: {
          ...original.engineInput,
          preferences: [{ rule: "Use a newly selected first-person style." }],
        },
      },
      { repository, runSlot: retryRunner, now: () => 2_000 },
    );

    expect(retry).toMatchObject({ kind: "failed", reason: "state_conflict" });
    expect(retryRunner).not.toHaveBeenCalled();
  });

  test("returns busy to a concurrent claimant without duplicating its writer work", async () => {
    const repository = new MemoryRepository();
    let markStarted!: () => void;
    let releaseWriter!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const runSlot = vi.fn(async (input: ModeledDraftSlotInput) => {
      markStarted();
      await writerGate;
      return accepted(input, distinctBodies[input.slot.index]);
    });
    const input = batchInput({ count: 2, sources: sources.slice(0, 2) });

    const first = executeModeledDraftBatch(input, {
      repository,
      runSlot,
      now: () => 1_000,
    });
    await started;
    const concurrent = await executeModeledDraftBatch(input, {
      repository,
      runSlot,
      now: () => 1_001,
    });

    expect(concurrent).toMatchObject({
      kind: "incomplete",
      batchId: "batch-1",
      reason: "busy",
      preservedSlots: 0,
    });
    expect(concurrent).not.toHaveProperty("artifacts");

    releaseWriter();
    expect((await first).kind).toBe("complete");
    expect(runSlot).toHaveBeenCalledTimes(2);
  });

  test("does not checkpoint or publish a writer result after cancellation", async () => {
    const repository = new MemoryRepository();
    const acceptSlot = vi.spyOn(repository, "acceptSlot");
    const complete = vi.spyOn(repository, "complete");
    const controller = new AbortController();
    let started!: () => void;
    let finish!: () => void;
    const writerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const writerGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runSlot = vi.fn(async (input: ModeledDraftSlotInput) => {
      started();
      await writerGate;
      return accepted(input, distinctBodies[input.slot.index]);
    });

    const work = executeModeledDraftBatch(
      batchInput({
        count: 2,
        sources: sources.slice(0, 2),
        signal: controller.signal,
      }),
      { repository, runSlot, now: () => 1_000 },
    );
    await writerStarted;
    controller.abort();
    finish();

    await expect(work).resolves.toMatchObject({
      kind: "incomplete",
      reason: "cancelled",
      preservedSlots: 0,
    });
    expect(acceptSlot).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  test("does not replay an already-completed batch after cancellation", async () => {
    const controller = new AbortController();
    const artifacts = [
      taggedArtifact(0, sources[0], distinctBodies[0]),
      taggedArtifact(1, sources[1], distinctBodies[1]),
    ];
    const repository = acquireOnlyRepository({
      kind: "complete",
      batchId: "batch-1",
      artifacts,
    });
    vi.mocked(repository.acquire).mockImplementation(async () => {
      controller.abort();
      return { kind: "complete", batchId: "batch-1", artifacts };
    });

    const result = await executeModeledDraftBatch(
      batchInput({
        count: 2,
        sources: sources.slice(0, 2),
        signal: controller.signal,
      }),
      { repository, runSlot: successfulSlotRunner(), now: () => 1_000 },
    );

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: "cancelled",
      preservedSlots: 0,
    });
    expect(result).not.toHaveProperty("artifacts");
  });

  test("does not publish when cancellation races with atomic completion", async () => {
    const controller = new AbortController();
    const repository = new MemoryRepository();
    const complete = repository.complete.bind(repository);
    vi.spyOn(repository, "complete").mockImplementation(async () => {
      const result = await complete();
      controller.abort();
      return result;
    });

    const result = await executeModeledDraftBatch(
      batchInput({
        count: 2,
        sources: sources.slice(0, 2),
        signal: controller.signal,
      }),
      { repository, runSlot: successfulSlotRunner(), now: () => 1_000 },
    );

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: "cancelled",
      preservedSlots: 2,
    });
    expect(result).not.toHaveProperty("artifacts");
  });

  test("bounds a non-cooperative store claim by the batch deadline", async () => {
    const repository: ModeledDraftBatchRepository = {
      acquire: vi.fn(() => new Promise<ModeledDraftBatchAcquireResult>(() => {})),
      acceptSlot: vi.fn(async () => false),
      replaceSlotSource: vi.fn(async () => false),
      complete: vi.fn(async () => ({ kind: "incomplete" as const })),
      release: vi.fn(async () => {}),
    };

    const result = await executeModeledDraftBatch(
      batchInput({
        count: 2,
        sources: sources.slice(0, 2),
        deadlineAtMs: 10,
      }),
      { repository, runSlot: successfulSlotRunner(), now: () => 0 },
    );

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: "deadline",
      preservedSlots: 0,
    });
  });

  test("classifies the outer watcher abort at its absolute deadline as deadline", async () => {
    const controller = new AbortController();
    controller.abort();
    let clockReads = 0;
    const now = () => (clockReads++ === 0 ? 0 : 100);
    const repository = new MemoryRepository();
    const acquire = vi.spyOn(repository, "acquire");

    const result = await executeModeledDraftBatch(
      batchInput({
        count: 2,
        sources: sources.slice(0, 2),
        signal: controller.signal,
        deadlineAtMs: 100,
      }),
      { repository, runSlot: successfulSlotRunner(), now },
    );

    expect(result).toMatchObject({ kind: "incomplete", reason: "deadline" });
    expect(acquire).not.toHaveBeenCalled();
  });

  test("checkpoints a completed sibling before a non-cooperative writer times out", async () => {
    const repository = new MemoryRepository();
    const runSlot = vi.fn(async (input: ModeledDraftSlotInput) => {
      if (input.slot.index === 1) {
        return new Promise<ModeledDraftSlotOutcome>(() => {});
      }
      return accepted(input, distinctBodies[0]);
    });

    const result = await executeModeledDraftBatch(
      batchInput({
        count: 2,
        sources: sources.slice(0, 2),
        deadlineAtMs: 20,
      }),
      { repository, runSlot, now: () => 0 },
    );

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: "deadline",
      preservedSlots: 1,
    });
  });

  test.each([
    [
      "slot checkpoint",
      (repository: MemoryRepository) => {
        vi.spyOn(repository, "acceptSlot").mockImplementation(
          () => new Promise<boolean>(() => {}),
        );
      },
      0,
    ],
    [
      "exact completion",
      (repository: MemoryRepository) => {
        vi.spyOn(repository, "complete").mockImplementation(
          () => new Promise<never>(() => {}),
        );
      },
      2,
    ],
  ] as const)(
    "bounds a non-cooperative %s call and preserves only durable slots",
    async (_stage, configure, expectedPreserved) => {
      const repository = new MemoryRepository();
      configure(repository);

      const result = await executeModeledDraftBatch(
        batchInput({
          count: 2,
          sources: sources.slice(0, 2),
          deadlineAtMs: 20,
        }),
        { repository, runSlot: successfulSlotRunner(), now: () => 0 },
      );

      expect(result).toMatchObject({
        kind: "incomplete",
        reason: "deadline",
        preservedSlots: expectedPreserved,
      });
    },
  );

  test("completes out of order at the five-slot boundary while publishing deterministic order", async () => {
    const repository = new MemoryRepository();
    const acceptSlot = vi.spyOn(repository, "acceptSlot");
    const complete = vi.spyOn(repository, "complete");
    const releases: Array<() => void> = [];
    const gates = Array.from({ length: 5 }, () =>
      new Promise<void>((resolve) => releases.push(resolve)),
    );
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;
    let peak = 0;
    const runSlot = vi.fn(async (input: ModeledDraftSlotInput) => {
      started.push(input.slot.index);
      active += 1;
      peak = Math.max(peak, active);
      await gates[input.slot.index];
      active -= 1;
      finished.push(input.slot.index);
      return accepted(input, distinctBodies[input.slot.index]);
    });

    const work = executeModeledDraftBatch(
      batchInput({ count: 5, sources: sources.slice(0, 5) }),
      { repository, runSlot, now: () => 1_000 },
    );
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releases[1]();
    await vi.waitFor(() => expect(finished).toEqual([1]));
    releases[0]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[3]();
    await vi.waitFor(() => expect(finished).toEqual([1, 0, 3]));
    releases[2]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    releases[4]();

    const result = await work;
    expect(result.kind).toBe("complete");
    expect(finished).toEqual([1, 0, 3, 2, 4]);
    expect(
      result.kind === "complete"
        ? result.artifacts.map((artifact) => ({
            slot: artifact.meta?.modeled_draft_slot_index,
            source: artifact.meta?.source_post_id,
          }))
        : [],
    ).toEqual(
      Array.from({ length: 5 }, (_, index) => ({
        slot: index,
        source: `source-${index + 1}`,
      })),
    );
    expect(peak).toBe(2);
    expect(acceptSlot).toHaveBeenCalledTimes(5);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test("replaces a later duplicate body without rerunning an accepted slot", async () => {
    const repository = new MemoryRepository();
    const calls: Array<{ slot: number; source: string }> = [];
    const runSlot = vi.fn(async (input: ModeledDraftSlotInput) => {
      calls.push({ slot: input.slot.index, source: input.source.id });
      const body =
        input.slot.index === 1 && input.source.id === "source-2"
          ? distinctBodies[0]
          : distinctBodies[input.slot.index];
      return accepted(input, body);
    });

    const result = await executeModeledDraftBatch(
      batchInput({ count: 2, sources: sources.slice(0, 3) }),
      { repository, runSlot, now: () => 1_000 },
    );

    expect(result.kind).toBe("complete");
    expect(
      result.kind === "complete"
        ? result.artifacts.map((artifact) => artifact.meta?.source_post_id)
        : [],
    ).toEqual(["source-1", "source-3"]);
    expect(calls).toEqual([
      { slot: 0, source: "source-1" },
      { slot: 1, source: "source-2" },
      { slot: 1, source: "source-3" },
    ]);
  });

  test.each(["false", "throw"] as const)(
    "fails closed and preserves accepted siblings when source replacement returns %s",
    async (mode) => {
      const repository = new MemoryRepository();
      repository.replaceFailure = { slotIndex: 1, mode };
      const runSlot = vi.fn(async (input: ModeledDraftSlotInput) =>
        input.slot.index === 0
          ? accepted(input, distinctBodies[0])
          : {
              kind: "rejected" as const,
              slot: input.slot,
              code: "source_fidelity" as const,
              inputTokens: 80,
              outputTokens: 20,
            },
      );

      const result = await executeModeledDraftBatch(
        batchInput({ count: 2, sources: sources.slice(0, 3) }),
        { repository, runSlot, now: () => 1_000 },
      );

      expect(result).toMatchObject({
        kind: "incomplete",
        reason: "store_unavailable",
        preservedSlots: 1,
        requestedCount: 2,
      });
      expect(result).not.toHaveProperty("artifacts");
    },
  );

  test("bounds a non-cooperative source replacement by the batch deadline", async () => {
    const repository = new MemoryRepository();
    repository.replaceFailure = { slotIndex: 1, mode: "hang" };
    const runSlot = vi.fn(async (input: ModeledDraftSlotInput) =>
      input.slot.index === 0
        ? accepted(input, distinctBodies[0])
        : {
            kind: "rejected" as const,
            slot: input.slot,
            code: "source_fidelity" as const,
            inputTokens: 80,
            outputTokens: 20,
          },
    );

    const result = await executeModeledDraftBatch(
      batchInput({
        count: 2,
        sources: sources.slice(0, 3),
        deadlineAtMs: 20,
      }),
      { repository, runSlot, now: () => 0 },
    );

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: "deadline",
      preservedSlots: 1,
      requestedCount: 2,
    });
    expect(result).not.toHaveProperty("artifacts");
  });

  test("returns typed source-pool exhaustion while carrying the accepted slots", async () => {
    const repository = new MemoryRepository();
    const runSlot = vi.fn(async (input: ModeledDraftSlotInput) =>
      input.slot.index < 2
        ? accepted(input, distinctBodies[input.slot.index])
        : {
            kind: "rejected" as const,
            slot: input.slot,
            code: "source_fidelity" as const,
            inputTokens: 80,
            outputTokens: 20,
          },
    );

    const result = await executeModeledDraftBatch(
      batchInput({ count: 3, sources: sources.slice(0, 3) }),
      { repository, runSlot, now: () => 1_000 },
    );

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: "source_pool_exhausted",
      preservedSlots: 2,
      preservedArtifacts: [
        { id: "artifact-0-source-1" },
        { id: "artifact-1-source-2" },
      ],
      requestedCount: 3,
    });
    expect(result).not.toHaveProperty("artifacts");
    expect(runSlot.mock.calls.filter(([input]) => input.slot.index < 2)).toHaveLength(2);
  });

  test.each([
    ["reviewer unavailability", "reviewer_unavailable", "reviewer_unavailable"],
    ["a malformed slot protocol", "protocol_error", "protocol_error"],
    ["cancellation", "cancelled", "cancelled"],
    ["the deadline", "deadline", "deadline"],
  ] as const)(
    "%s preserves earlier slots without exposing partial artifacts",
    async (_name, outcomeKind, expectedReason) => {
      const repository = new MemoryRepository();
      const runSlot = vi.fn(
        async (input: ModeledDraftSlotInput): Promise<ModeledDraftSlotOutcome> => {
          if (input.slot.index === 0) {
            return accepted(input, distinctBodies[0]);
          }
          if (outcomeKind === "protocol_error") {
            return {
              kind: "protocol_error",
              slot: input.slot,
              code: "missing_terminal",
              inputTokens: 40,
              outputTokens: 10,
            };
          }
          return {
            kind: outcomeKind,
            slot: input.slot,
            inputTokens: 40,
            outputTokens: 10,
          };
        },
      );

      const result = await executeModeledDraftBatch(
        batchInput({ count: 2, sources: sources.slice(0, 2) }),
        { repository, runSlot, now: () => 1_000 },
      );

      expect(result).toMatchObject({
        kind: "incomplete",
        reason: expectedReason,
        preservedSlots: 1,
        requestedCount: 2,
      });
      expect(result).not.toHaveProperty("artifacts");
    },
  );

  test.each([
    [
      "accept returns false",
      (repository: MemoryRepository) => {
        repository.acceptFailure = { slotIndex: 1, mode: "false" };
      },
      1,
    ],
    [
      "accept throws",
      (repository: MemoryRepository) => {
        repository.acceptFailure = { slotIndex: 1, mode: "throw" };
      },
      1,
    ],
    [
      "complete reports incomplete",
      (repository: MemoryRepository) => {
        repository.completeFailure = "incomplete";
      },
      2,
    ],
    [
      "complete loses its lease",
      (repository: MemoryRepository) => {
        repository.completeFailure = "lease_lost";
      },
      2,
    ],
    [
      "complete throws",
      (repository: MemoryRepository) => {
        repository.completeFailure = "throw";
      },
      2,
    ],
  ] satisfies Array<[
    string,
    (repository: MemoryRepository) => void,
    number,
  ]>)(
    "normalizes repository failure when %s without exposing artifacts",
    async (_name, configure, expectedPreserved) => {
      const repository = new MemoryRepository();
      configure(repository);

      const result = await executeModeledDraftBatch(
        batchInput({ count: 2, sources: sources.slice(0, 2) }),
        { repository, runSlot: successfulSlotRunner(), now: () => 1_000 },
      );

      expect(result).toMatchObject({
        kind: "incomplete",
        reason: "store_unavailable",
        preservedSlots: expectedPreserved,
        requestedCount: 2,
      });
      expect(result).not.toHaveProperty("artifacts");
    },
  );

  test("normalizes an unexpected slot-runner exception and preserves its sibling", async () => {
    const repository = new MemoryRepository();
    const runSlot = vi.fn(async (input: ModeledDraftSlotInput) => {
      if (input.slot.index === 1) throw new Error("writer adapter exploded");
      return accepted(input, distinctBodies[0]);
    });

    const result = await executeModeledDraftBatch(
      batchInput({ count: 2, sources: sources.slice(0, 2) }),
      { repository, runSlot, now: () => 1_000 },
    );

    expect(result).toMatchObject({
      kind: "incomplete",
      reason: "writer_unavailable",
      preservedSlots: 1,
    });
    expect(result).not.toHaveProperty("artifacts");
  });

  test("rethrows usage-persistence failures instead of disguising unbilled work", async () => {
    const repository = new MemoryRepository();
    const release = vi.spyOn(repository, "release");
    const runSlot = vi.fn(async () => {
      throw new UsagePersistenceError("usage insert unavailable");
    });

    await expect(
      executeModeledDraftBatch(
        batchInput({ count: 2, sources: sources.slice(0, 2) }),
        { repository, runSlot, now: () => 1_000 },
      ),
    ).rejects.toBeInstanceOf(UsagePersistenceError);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "store_unavailable" }),
    );
  });

  test("retains a settled sibling when another slot loses usage persistence", async () => {
    const repository = new MemoryRepository();
    const firstRunner = vi.fn(async (input: ModeledDraftSlotInput) => {
      if (input.slot.index === 0) {
        return accepted(input, distinctBodies[0]);
      }
      await Promise.resolve();
      throw new UsagePersistenceError("usage insert unavailable");
    });
    const input = batchInput({ count: 2, sources: sources.slice(0, 2) });

    await expect(
      executeModeledDraftBatch(input, {
        repository,
        runSlot: firstRunner,
        now: () => 1_000,
      }),
    ).rejects.toBeInstanceOf(UsagePersistenceError);

    const retryRunner = successfulSlotRunner();
    const retry = await executeModeledDraftBatch(input, {
      repository,
      runSlot: retryRunner,
      now: () => 2_000,
    });
    expect(retry.kind).toBe("complete");
    expect(retryRunner).toHaveBeenCalledTimes(1);
    expect(retryRunner.mock.calls[0][0].slot.index).toBe(1);
  });

  test.each(["slot", "source"] as const)(
    "rejects freshly generated artifacts with mismatched %s provenance",
    async (field) => {
      const repository = new MemoryRepository();
      const runSlot = vi.fn(async (input: ModeledDraftSlotInput) => {
        const outcome = accepted(input, distinctBodies[input.slot.index]);
        return input.slot.index === 0
          ? outcome
          : { ...outcome, artifact: corruptProvenance(outcome.artifact, field) };
      });

      const result = await executeModeledDraftBatch(
        batchInput({ count: 2, sources: sources.slice(0, 2) }),
        { repository, runSlot, now: () => 1_000 },
      );

      expect(result).toMatchObject({
        kind: "incomplete",
        reason: "protocol_error",
        preservedSlots: 1,
      });
      expect(result).not.toHaveProperty("artifacts");
    },
  );

  test("fails closed when completed storage replays near-duplicate drafts", async () => {
    const firstBody = distinctBodies[0];
    const nearDuplicateBody = firstBody.replace("useful", "valuable");
    const repository = acquireOnlyRepository({
      kind: "complete",
      batchId: "batch-1",
      artifacts: [
        taggedArtifact(0, sources[0], firstBody),
        taggedArtifact(1, sources[1], nearDuplicateBody),
      ],
    });
    const runSlot = successfulSlotRunner();

    const result = await executeModeledDraftBatch(
      batchInput({ count: 2, sources: sources.slice(0, 2) }),
      { repository, runSlot, now: () => 1_000 },
    );

    expect(result).toMatchObject({ kind: "failed", reason: "state_corrupt" });
    expect(runSlot).not.toHaveBeenCalled();
  });

  test.each(["slot", "source"] as const)(
    "fails closed when completed storage replays mismatched %s provenance",
    async (field) => {
      const artifacts = [
        taggedArtifact(0, sources[0], distinctBodies[0]),
        corruptProvenance(
          taggedArtifact(1, sources[1], distinctBodies[1]),
          field,
        ),
      ];
      const repository = acquireOnlyRepository({
        kind: "complete",
        batchId: "batch-1",
        artifacts,
      });
      const runSlot = successfulSlotRunner();

      const result = await executeModeledDraftBatch(
        batchInput({ count: 2, sources: sources.slice(0, 2) }),
        { repository, runSlot, now: () => 1_000 },
      );

      expect(result).toMatchObject({ kind: "failed", reason: "state_corrupt" });
      expect(result).not.toHaveProperty("artifacts");
      expect(runSlot).not.toHaveBeenCalled();
    },
  );

  test("fails closed when completed storage drops the source URL from artifact metadata", async () => {
    const second = taggedArtifact(1, sources[1], distinctBodies[1]);
    const metaWithoutSourceUrl = { ...(second.meta ?? {}) };
    delete metaWithoutSourceUrl.source_url;
    const repository = acquireOnlyRepository({
      kind: "complete",
      batchId: "batch-1",
      artifacts: [
        taggedArtifact(0, sources[0], distinctBodies[0]),
        { ...second, meta: metaWithoutSourceUrl },
      ],
    });
    const runSlot = successfulSlotRunner();

    const result = await executeModeledDraftBatch(
      batchInput({ count: 2, sources: sources.slice(0, 2) }),
      { repository, runSlot, now: () => 1_000 },
    );

    expect(result).toMatchObject({ kind: "failed", reason: "state_corrupt" });
    expect(result).not.toHaveProperty("artifacts");
    expect(runSlot).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a source history reused by two slots",
      [
        {
          index: 0,
          state: "assigned" as const,
          sourceIndex: 0,
          sourceHistory: [0],
          replacements: 0,
        },
        {
          index: 1,
          state: "assigned" as const,
          sourceIndex: 0,
          sourceHistory: [0],
          replacements: 0,
        },
      ],
    ],
    [
      "more than one replacement",
      [
        {
          index: 0,
          state: "assigned" as const,
          sourceIndex: 2,
          sourceHistory: [0, 1, 2],
          replacements: 2,
        },
        {
          index: 1,
          state: "assigned" as const,
          sourceIndex: 3,
          sourceHistory: [3],
          replacements: 0,
        },
      ],
    ],
    [
      "an accepted slot with forged provenance",
      [
        {
          index: 0,
          state: "accepted" as const,
          sourceIndex: 0,
          sourceHistory: [0],
          replacements: 0,
          artifact: corruptProvenance(
            taggedArtifact(0, sources[0], distinctBodies[0]),
            "source",
          ),
        },
        {
          index: 1,
          state: "assigned" as const,
          sourceIndex: 1,
          sourceHistory: [1],
          replacements: 0,
        },
      ],
    ],
  ] satisfies Array<[string, ModeledDraftSlotCheckpoint[]]>)(
    "rejects corrupt resumable state before writing: %s",
    async (_name, slots) => {
      const repository: ModeledDraftBatchRepository = {
        acquire: vi.fn(async (input) => ({
          kind: "acquired" as const,
          checkpoint: {
            batchId: "batch-1",
            leaseToken: "lease-1",
            requestHash: input.requestHash,
            requestedCount: 2,
            sources: sources.slice(0, 4),
            slots,
          },
        })),
        acceptSlot: vi.fn(async () => false),
        replaceSlotSource: vi.fn(async () => false),
        complete: vi.fn(async () => ({ kind: "incomplete" as const })),
        release: vi.fn(async () => {}),
      };
      const runSlot = successfulSlotRunner();

      const result = await executeModeledDraftBatch(
        batchInput({ count: 2, sources: sources.slice(0, 4) }),
        { repository, runSlot, now: () => 1_000 },
      );

      expect(result).toMatchObject({ kind: "failed", reason: "state_corrupt" });
      expect(runSlot).not.toHaveBeenCalled();
    },
  );
});
