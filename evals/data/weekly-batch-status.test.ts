import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// The weekly-batch LIVE STATUS layer (batch_runs): create/update/read run rows,
// the stale-run recovery (a dead after() flips to 'failed' so the UI stops
// spinning), and that runWeeklyBatch publishes the right stages + counters as it
// works. This is the poll surface behind the step-by-step progress UI, so its
// correctness is what makes the feature feel agentic rather than a blind wait.
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));

// completeChat + usage stubbed (this file is about run-state, not generation).
const chatQueue: Array<{ text?: string; finishReason?: string }> = [];
vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    completeChat: async () => {
      const next = chatQueue.shift() ?? { text: "A".repeat(300), finishReason: "stop" };
      return { text: next.text ?? "A".repeat(300), toolArgs: null, finishReason: next.finishReason ?? "stop", usage: { prompt_tokens: 10, completion_tokens: 10 } };
    },
  };
});

// runTool → canned sources.
const toolRef: { current: (name: string, args: unknown) => unknown } = {
  current: () => ({ ok: true, posts: [] }),
};
vi.mock("@/lib/agent/tools", () => ({
  runTool: async (name: string, args: unknown) => toolRef.current(name, args),
}));

const {
  createBatchRun,
  updateBatchRun,
  latestBatchRun,
  runWeeklyBatch,
  BATCH_RUN_STALE_MS,
} = await import("@/lib/batch/weekly");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  chatQueue.length = 0;
  toolRef.current = () => ({ ok: true, posts: [] });
});

describe("createBatchRun", () => {
  test("inserts a pending run for the workspace and returns the id", async () => {
    dbRef.current = makeFakeSupabase({ batch_runs: { single: { id: "run-1" } } });
    const id = await createBatchRun("ws");
    expect(id).toBe("run-1");
    const q = queryFor(dbRef.current, "batch_runs")!;
    const payload = q.filters.find((f) => f.method === "insert")!.args[0] as Record<string, unknown>;
    expect(payload.workspace_id).toBe("ws");
    expect(payload.status).toBe("pending");
  });

  test("returns null on a DB error (route still responds)", async () => {
    dbRef.current = makeFakeSupabase({ batch_runs: { error: { message: "boom" } } });
    expect(await createBatchRun("ws")).toBeNull();
  });
});

describe("updateBatchRun — workspace-scoped patch", () => {
  test("scopes the update by id AND workspace_id, bumps updated_at", async () => {
    await updateBatchRun("run-1", "ws", { status: "running", stage: "Drafting" });
    const q = queryFor(dbRef.current, "batch_runs")!;
    const patch = q.filters.find((f) => f.method === "update")!.args[0] as Record<string, unknown>;
    expect(patch.status).toBe("running");
    expect(patch.stage).toBe("Drafting");
    expect(typeof patch.updated_at).toBe("string");
    const eqs = q.filters.filter((f) => f.method === "eq").map((f) => f.args[0]);
    expect(eqs).toContain("id");
    expect(eqs).toContain("workspace_id");
  });

  test("finished:true stamps finished_at", async () => {
    await updateBatchRun("run-1", "ws", { status: "done", finished: true });
    const q = queryFor(dbRef.current, "batch_runs")!;
    const patch = q.filters.find((f) => f.method === "update")!.args[0] as Record<string, unknown>;
    expect(typeof patch.finished_at).toBe("string");
  });

  test("a DB throw is swallowed (progress is best-effort, never breaks the run)", async () => {
    dbRef.current = makeFakeSupabase({ batch_runs: { error: { message: "boom" } } });
    // Should resolve, not reject.
    await expect(updateBatchRun("run-1", "ws", { stage: "x" })).resolves.toBeUndefined();
  });
});

describe("latestBatchRun — read + stale recovery", () => {
  test("returns the latest run as-is when it's fresh", async () => {
    const fresh = {
      id: "run-1", workspace_id: "ws", status: "running", stage: "Drafting 2 of 5",
      total: 5, attempted: 2, created: 1, error: null,
      started_at: "2026-07-02T00:00:00.000Z", updated_at: "2026-07-02T00:00:00.000Z", finished_at: null,
    };
    dbRef.current = makeFakeSupabase({ batch_runs: { single: fresh } });
    const nowMs = new Date(fresh.updated_at).getTime() + 1000; // 1s later — fresh
    const run = await latestBatchRun("ws", nowMs);
    expect(run?.status).toBe("running");
    expect(run?.stage).toBe("Drafting 2 of 5");
  });

  test("flips a STALE pending/running run to 'failed' so the UI stops spinning", async () => {
    const stale = {
      id: "run-1", workspace_id: "ws", status: "running", stage: "Drafting",
      total: 5, attempted: 2, created: 1, error: null,
      started_at: "2026-07-02T00:00:00.000Z", updated_at: "2026-07-02T00:00:00.000Z", finished_at: null,
    };
    dbRef.current = makeFakeSupabase({ batch_runs: { single: stale } });
    const nowMs = new Date(stale.updated_at).getTime() + BATCH_RUN_STALE_MS + 1000;
    const run = await latestBatchRun("ws", nowMs);
    expect(run?.status).toBe("failed");
    // And it persisted the flip: an UPDATE was issued against batch_runs (a
    // separate query from the initial SELECT).
    const updated = dbRef.current.queries
      .filter((q) => q.table === "batch_runs")
      .some((q) => q.filters.some((f) => f.method === "update"));
    expect(updated).toBe(true);
  });

  test("a terminal (done) run is returned untouched even if old", async () => {
    const done = {
      id: "run-1", workspace_id: "ws", status: "done", stage: "Added 4 drafts",
      total: 5, attempted: 5, created: 4, error: null,
      started_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
      finished_at: "2026-07-01T00:05:00.000Z",
    };
    dbRef.current = makeFakeSupabase({ batch_runs: { single: done } });
    const run = await latestBatchRun("ws", Date.now());
    expect(run?.status).toBe("done");
  });

  test("null when the workspace has never run a batch", async () => {
    dbRef.current = makeFakeSupabase({ batch_runs: { single: null } });
    expect(await latestBatchRun("ws", Date.now())).toBeNull();
  });
});

describe("runWeeklyBatch — progress publishing", () => {
  // Capture every stage the run publishes by recording the update patches.
  function stagesWritten(): string[] {
    return dbRef.current.queries
      .filter((q) => q.table === "batch_runs")
      .flatMap((q) => q.filters.filter((f) => f.method === "update"))
      .map((f) => (f.args[0] as { stage?: string }).stage)
      .filter((s): s is string => typeof s === "string");
  }

  test("no sources → publishes a 'nothing to adapt' terminal stage", async () => {
    toolRef.current = () => ({ ok: true, posts: [] });
    const res = await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1",
    });
    expect(res.reason).toBe("no_sources");
    const stages = stagesWritten();
    expect(stages.some((s) => /finding/i.test(s))).toBe(true);
    expect(stages.some((s) => /adapt this week/i.test(s))).toBe(true);
  });

  test("with sources → publishes finding → drafting N → added stages + counts", async () => {
    // batch_runs insert returns an id; chat_artifacts insert returns a draft.
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "t", body: "b" } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "fresh source post text here", post_url: null, post_type: "regular" }] };
    };
    const res = await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1",
    });
    expect(res.drafts.length).toBe(1);
    const stages = stagesWritten();
    expect(stages.some((s) => /drafting 1 of 1/i.test(s))).toBe(true);
    expect(stages.some((s) => /added 1 draft/i.test(s))).toBe(true);
  });

  test("runId omitted → no batch_runs writes (silent mode for cron/tests)", async () => {
    toolRef.current = () => ({ ok: true, posts: [] });
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z",
    });
    expect(queryFor(dbRef.current, "batch_runs")).toBeUndefined();
  });
});
