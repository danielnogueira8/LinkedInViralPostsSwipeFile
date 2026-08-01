import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runDailyPipeline: vi.fn(),
  supabaseAdmin: vi.fn(),
}));

vi.mock("@/lib/pipeline", () => ({
  runDailyPipeline: mocks.runDailyPipeline,
}));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));
vi.mock("../../lib/supabase", () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { startBackgroundRun } from "@/lib/run-tracker";

describe("background run ownership", () => {
  beforeEach(() => {
    mocks.runDailyPipeline.mockReset();
    mocks.supabaseAdmin.mockReset();
    (globalThis as { __activeRuns?: Map<string, unknown> }).__activeRuns?.clear();

    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "order", "limit"]) {
      query[method] = () => query;
    }
    query.maybeSingle = async () => ({
      data: { id: "run-1" },
      error: null,
    });
    mocks.supabaseAdmin.mockReturnValue({ from: () => query });
  });

  test("shares the in-flight run while its database id is still being discovered", async () => {
    let finishPipeline!: (value: { runId: string }) => void;
    mocks.runDailyPipeline.mockReturnValue(
      new Promise<{ runId: string }>((resolve) => {
        finishPipeline = resolve;
      }),
    );

    const dependencies = {
      runDailyPipeline: mocks.runDailyPipeline,
      supabaseAdmin: mocks.supabaseAdmin,
    };
    const firstPromise = startBackgroundRun("workspace-ownership", dependencies);
    const secondPromise = startBackgroundRun("workspace-ownership", dependencies);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(mocks.runDailyPipeline).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ runId: "run-1", alreadyRunning: false });
    expect(second).toEqual({ runId: "run-1", alreadyRunning: true });

    finishPipeline({ runId: "run-1" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  test("surfaces a pipeline failure instead of waiting forever for an id", async () => {
    mocks.runDailyPipeline.mockRejectedValue(new Error("pipeline failed"));

    await expect(
      startBackgroundRun("workspace-failure", {
        runDailyPipeline: mocks.runDailyPipeline,
        supabaseAdmin: mocks.supabaseAdmin,
        sleep: async () => {},
      }),
    ).rejects.toThrow("pipeline failed");
  });
});
