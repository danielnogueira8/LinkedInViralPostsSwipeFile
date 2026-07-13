import { describe, expect, it, vi } from "vitest";
import {
  WeeklyBatch,
  type WeeklyBatchDependencies,
} from "@/lib/batch/weekly-batch";

function dependencies(
  overrides: Partial<WeeklyBatchDependencies> = {},
): WeeklyBatchDependencies {
  return {
    allowance: vi.fn(async () => ({ ok: true, used: 0, limit: 5 })),
    inFlight: vi.fn(async () => false),
    claim: vi.fn(async (_workspaceId, id) => ({ ok: true as const, id })),
    createChat: vi.fn(async () => "chat-1"),
    enqueue: vi.fn(async () => ({ id: "job-1" })) as never,
    update: vi.fn(async () => undefined),
    latest: vi.fn(async () => null),
    readiness: vi.fn(async () => ({ available: 7, onCooldown: false, retryAt: null })),
    slots: vi.fn(async () => []),
    runPipeline: vi.fn(async (input) => ({
      batchId: input.batchId,
      drafts: [],
      attempted: 0,
    })),
    randomId: () => "batch-1",
    now: () => Date.parse("2026-07-13T10:00:00.000Z"),
    ...overrides,
  } as WeeklyBatchDependencies;
}

describe("WeeklyBatch", () => {
  it("starts one claimed background run and returns a public queued outcome", async () => {
    const deps = dependencies();
    const domain = new WeeklyBatch(deps);
    const outcome = await domain.start({ workspaceId: "ws-1", userId: "user-1" });

    expect(outcome).toEqual({
      ok: true,
      jobId: "job-1",
      batchId: "batch-1",
      runId: "batch-1",
      chatId: "chat-1",
      status: "queued",
    });
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      type: "weekly_batch",
      payload: expect.objectContaining({ batchId: "batch-1", runId: "batch-1" }),
    }));
  });

  it("returns an in-flight outcome without claiming or enqueueing", async () => {
    const deps = dependencies({ inFlight: vi.fn(async () => true) });
    const outcome = await new WeeklyBatch(deps).start({
      workspaceId: "ws-1",
      userId: "user-1",
    });
    expect(outcome).toMatchObject({ ok: false, status: 409, reason: "in_flight" });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("returns the public allowance rejection without touching run state", async () => {
    const deps = dependencies({
      allowance: vi.fn(async () => ({
        ok: false as const,
        reason: "monthly" as const,
        message: "Monthly AI budget reached.",
        used: 5,
        limit: 5,
      })),
    });
    await expect(new WeeklyBatch(deps).start({ workspaceId: "ws-1", userId: "user-1" }))
      .resolves.toEqual({
        ok: false,
        status: 429,
        reason: "monthly",
        message: "Monthly AI budget reached.",
      });
    expect(deps.inFlight).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("normalizes a claim conflict to the same in-flight outcome", async () => {
    const deps = dependencies({
      claim: vi.fn(async () => ({ ok: false as const, conflict: true, error: new Error("duplicate") })),
    });
    await expect(new WeeklyBatch(deps).start({ workspaceId: "ws-1", userId: "user-1" }))
      .resolves.toMatchObject({ ok: false, status: 409, reason: "in_flight" });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("propagates a non-conflict claim failure", async () => {
    const error = new Error("database unavailable");
    const deps = dependencies({
      claim: vi.fn(async () => ({ ok: false as const, conflict: false, error })),
    });
    await expect(new WeeklyBatch(deps).start({ workspaceId: "ws-1", userId: "user-1" }))
      .rejects.toBe(error);
  });

  it("marks the claimed run failed when queueing fails", async () => {
    const error = new Error("queue unavailable");
    const deps = dependencies({ enqueue: vi.fn(async () => { throw error; }) as never });
    await expect(new WeeklyBatch(deps).start({ workspaceId: "ws-1", userId: "user-1" }))
      .rejects.toBe(error);
    expect(deps.update).toHaveBeenCalledWith("batch-1", "ws-1", expect.objectContaining({
      status: "failed",
      stage: "Queue unavailable",
      finished: true,
    }));
  });

  it("combines run, readiness, and slots behind one status outcome", async () => {
    const deps = dependencies({
      latest: vi.fn(async () => ({ id: "batch-1", status: "running" })) as never,
      slots: vi.fn(async () => [{ id: "slot-1" }]) as never,
    });
    const status = await new WeeklyBatch(deps).status({
      workspaceId: "ws-1",
      includeReadiness: true,
      includeRun: true,
      batchId: "batch-1",
    });
    expect(status.run).toMatchObject({ id: "batch-1", status: "running" });
    expect(status.readiness).toMatchObject({ available: 7 });
    expect(status.slots).toEqual([{ id: "slot-1" }]);
  });

  it("reads slots without coupling the high-frequency poll to run recovery", async () => {
    const deps = dependencies({ slots: vi.fn(async () => []) });
    await new WeeklyBatch(deps).status({
      workspaceId: "ws-1",
      batchId: "batch-1",
      includeRun: false,
    });
    expect(deps.slots).toHaveBeenCalledWith("ws-1", "batch-1");
    expect(deps.latest).not.toHaveBeenCalled();
  });

  it("applies a worker transition before returning status", async () => {
    const deps = dependencies();
    await new WeeklyBatch(deps).status({
      workspaceId: "ws-1",
      includeRun: false,
      transition: {
        runId: "run-1",
        patch: { status: "running", stage: "Drafting" },
      },
    });
    expect(deps.update).toHaveBeenCalledWith(
      "run-1",
      "ws-1",
      { status: "running", stage: "Drafting" },
    );
  });

  it("delegates execution through the replaceable pipeline seam", async () => {
    const deps = dependencies();
    const result = await new WeeklyBatch(deps).run({
      workspaceId: "ws-1",
      batchId: "batch-1",
      nowIso: "2026-07-13T10:00:00.000Z",
    });
    expect(result).toMatchObject({ batchId: "batch-1", attempted: 0 });
    expect(deps.runPipeline).toHaveBeenCalledOnce();
  });
});
