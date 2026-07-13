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
