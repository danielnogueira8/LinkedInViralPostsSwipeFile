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
  createBatchChat,
  updateBatchRun,
  latestBatchRun,
  runWeeklyBatch,
  getBatchReadiness,
  settleStage,
  sourceFindingLine,
  BATCH_RUN_STALE_MS,
} = await import("@/lib/batch/weekly");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  chatQueue.length = 0;
  toolRef.current = () => ({ ok: true, posts: [] });
});

describe("createBatchRun", () => {
  test("inserts a pending run with the given id (id = batchId) for the workspace", async () => {
    dbRef.current = makeFakeSupabase({ batch_runs: { single: { id: "batch-1" } } });
    const id = await createBatchRun("ws", "batch-1");
    expect(id).toBe("batch-1");
    const q = queryFor(dbRef.current, "batch_runs")!;
    const payload = q.filters.find((f) => f.method === "insert")!.args[0] as Record<string, unknown>;
    expect(payload.id).toBe("batch-1");
    expect(payload.workspace_id).toBe("ws");
    expect(payload.status).toBe("pending");
  });

  test("returns null on a DB error (route still responds)", async () => {
    dbRef.current = makeFakeSupabase({ batch_runs: { error: { message: "boom" } } });
    expect(await createBatchRun("ws", "batch-1")).toBeNull();
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

  test("with sources → publishes finding → dispatched N → added stages", async () => {
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
    expect(stages.some((s) => /finding/i.test(s))).toBe(true);
    expect(stages.some((s) => /dispatched 1 writer/i.test(s))).toBe(true);
    expect(stages.some((s) => /1 draft ready to review/i.test(s))).toBe(true);
    // The live worker-lanes board is gone — the run no longer writes any
    // batch_draft_slots rows (the chat transcript replaced that surface).
    expect(queryFor(dbRef.current, "batch_draft_slots")).toBeUndefined();
  });

  test("runId omitted → no batch_runs writes (silent mode for cron/tests)", async () => {
    toolRef.current = () => ({ ok: true, posts: [] });
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z",
    });
    expect(queryFor(dbRef.current, "batch_runs")).toBeUndefined();
  });
});

describe("batch-as-chat — runs as a Cowork session", () => {
  test("createBatchChat inserts a chat + an intro assistant message", async () => {
    dbRef.current = makeFakeSupabase({ chats: { single: { id: "chat-1" } } });
    const id = await createBatchChat("ws", "Weekly batch — 2026-07-02");
    expect(id).toBe("chat-1");
    // chat row created with the title, and an assistant intro message written.
    const chatIns = queryFor(dbRef.current, "chats")!.filters.find((f) => f.method === "insert")!.args[0] as Record<string, unknown>;
    expect(chatIns.title).toBe("Weekly batch — 2026-07-02");
    const msgIns = queryFor(dbRef.current, "chat_messages")!.filters.find((f) => f.method === "insert")!.args[0] as Record<string, unknown>;
    expect(msgIns.role).toBe("assistant");
    expect(String(msgIns.content)).toMatch(/building your week/i);
  });

  test("with chatId, each filed draft sets chat_id + writes a companion chat message with the artifact", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "T", body: "B" } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "fresh source post here", post_url: "u", post_type: "regular" }] };
    };
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1", chatId: "chat-9",
    });
    // The draft insert carried the chat_id. (Several chat_artifacts queries run
    // — dedup reads etc. — so find the one that INSERTED.)
    const draftIns = dbRef.current.queries
      .filter((q) => q.table === "chat_artifacts")
      .flatMap((q) => q.filters.filter((f) => f.method === "insert").map((f) => f.args[0] as Record<string, unknown>))
      .find((p) => p.body !== undefined)!;
    expect(draftIns.chat_id).toBe("chat-9");
    // A chat_messages row carries the draft as an artifact (post kind, meta).
    const msgInserts = dbRef.current.queries
      .filter((q) => q.table === "chat_messages")
      .flatMap((q) => q.filters.filter((f) => f.method === "insert").map((f) => f.args[0] as Record<string, unknown>));
    const withArtifact = msgInserts.find((m) => Array.isArray(m.artifacts));
    expect(withArtifact).toBeDefined();
    const art = (withArtifact!.artifacts as Array<Record<string, unknown>>)[0];
    expect(art.kind).toBe("post");
    expect(art.id).toBe("d1");
  });

  test("without chatId, drafts insert chat_id null + NO chat_messages (headless)", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "T", body: "B" } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "fresh source post here", post_url: null, post_type: "regular" }] };
    };
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1",
    });
    const draftIns = dbRef.current.queries
      .filter((q) => q.table === "chat_artifacts")
      .flatMap((q) => q.filters.filter((f) => f.method === "insert").map((f) => f.args[0] as Record<string, unknown>))
      .find((p) => p.body !== undefined)!;
    expect(draftIns.chat_id).toBeNull();
    expect(queryFor(dbRef.current, "chat_messages")).toBeUndefined();
  });
});

describe("batch-as-chat — plan checklist + activity findings", () => {
  // Helper: every chat_messages insert (plan message, activity lines, drafts).
  function chatMessageInserts() {
    return dbRef.current.queries
      .filter((q) => q.table === "chat_messages")
      .flatMap((q) =>
        q.filters
          .filter((f) => f.method === "insert")
          .map((f) => f.args[0] as Record<string, unknown>),
      );
  }
  // Helper: every chat_messages update patch (the plan advancing in place).
  function chatMessageUpdates() {
    return dbRef.current.queries
      .filter((q) => q.table === "chat_messages")
      .flatMap((q) =>
        q.filters
          .filter((f) => f.method === "update")
          .map((f) => f.args[0] as Record<string, unknown>),
      );
  }
  // Pull the steps out of a _batch_plan tool_call patch/insert.
  function planStepsFrom(row: Record<string, unknown>): Array<{ id: string; status: string }> | null {
    const tcs = row.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined;
    const tc = tcs?.find((c) => c.function?.name === "_batch_plan");
    if (!tc?.function?.arguments) return null;
    return (JSON.parse(tc.function.arguments) as { steps: Array<{ id: string; status: string }> }).steps;
  }

  function withOneRegularSource() {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "T", body: "B" } },
      // The plan message's insert().select("id").single() must return an id so
      // the in-place updates fire.
      chat_messages: { single: { id: "plan-msg-1" } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "fresh source post here", post_url: "u", post_type: "regular" }] };
    };
  }

  test("with chatId, seeds a _batch_plan message and advances it to done", async () => {
    withOneRegularSource();
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1", chatId: "chat-9",
    });
    // A plan message was inserted with the three steps, first one active.
    const planInsert = chatMessageInserts().find((m) => planStepsFrom(m));
    expect(planInsert).toBeDefined();
    const seeded = planStepsFrom(planInsert!)!;
    expect(seeded.map((s) => s.id)).toEqual(["find", "draft", "review"]);
    expect(seeded[0].status).toBe("active");
    // The plan was patched in place (scoped by id + workspace) and ends with the
    // drafting step done — the run finished.
    const planUpdates = chatMessageUpdates().filter((m) => planStepsFrom(m));
    expect(planUpdates.length).toBeGreaterThan(0);
    const finalSteps = planStepsFrom(planUpdates[planUpdates.length - 1])!;
    const draftStep = finalSteps.find((s) => s.id === "draft")!;
    expect(draftStep.status).toBe("done");
  });

  test("plan updates are workspace-scoped by message id (no cross-workspace write)", async () => {
    withOneRegularSource();
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1", chatId: "chat-9",
    });
    const planUpdateQueries = dbRef.current.queries.filter(
      (q) =>
        q.table === "chat_messages" &&
        q.filters.some((f) => f.method === "update"),
    );
    expect(planUpdateQueries.length).toBeGreaterThan(0);
    for (const q of planUpdateQueries) {
      const eqs = q.filters.filter((f) => f.method === "eq");
      expect(eqs.some((f) => f.args[0] === "id" && f.args[1] === "plan-msg-1")).toBe(true);
      expect(eqs.some((f) => f.args[0] === "workspace_id" && f.args[1] === "ws")).toBe(true);
    }
  });

  test("writes an activity-finding line before the drafts land", async () => {
    withOneRegularSource();
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1", chatId: "chat-9",
    });
    const contents = chatMessageInserts()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter(Boolean);
    expect(contents.some((c) => /pulled .*top post/i.test(c))).toBe(true);
  });

  test("headless (no chatId) writes NO plan message or activity line", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "T", body: "B" } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "fresh source post here", post_url: null, post_type: "regular" }] };
    };
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1",
    });
    // No chat surface at all → the whole chat_messages table is untouched.
    expect(queryFor(dbRef.current, "chat_messages")).toBeUndefined();
  });

  test("a throw during setup flips the active plan step to 'failed' and posts an error into the chat", async () => {
    dbRef.current = makeFakeSupabase({
      chat_messages: { single: { id: "plan-msg-1" } },
    });
    // Force a throw AFTER the chat + plan are seeded: source selection calls
    // runTool, which we make reject (a transient read failure). Without the fix
    // the chat would sit on a spinning 'find' step forever.
    toolRef.current = () => {
      throw new Error("transient PostgREST failure");
    };
    await expect(
      runWeeklyBatch({
        workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1", chatId: "chat-9",
      }),
    ).rejects.toThrow(); // re-thrown so the route still flips batch_runs to failed
    // The plan was patched to mark the active ('find') step failed.
    const planUpdates = chatMessageUpdates().filter((m) => planStepsFrom(m));
    expect(planUpdates.length).toBeGreaterThan(0);
    const finalSteps = planStepsFrom(planUpdates[planUpdates.length - 1])!;
    expect(finalSteps.find((s) => s.id === "find")!.status).toBe("failed");
    // And an error message was written into the chat (not left silent).
    const errored = chatMessageInserts().some(
      (m) => typeof m.content === "string" && /snag building your batch/i.test(m.content),
    );
    expect(errored).toBe(true);
  });
});

describe("sourceFindingLine — the activity finding after source selection", () => {
  test("mixed regular + lead magnet spells out both", () => {
    const line = sourceFindingLine(5, 2);
    expect(line).toMatch(/7 of this week's top posts/i);
    expect(line).toMatch(/5 to adapt/i);
    expect(line).toMatch(/2 lead magnets/i);
  });
  test("only lead magnets", () => {
    expect(sourceFindingLine(0, 2)).toMatch(/2 lead magnets to adapt/i);
  });
  test("only regular, singular grammar", () => {
    const line = sourceFindingLine(1, 0);
    expect(line).toMatch(/1 of this week's top post\b/i);
    expect(line).not.toMatch(/lead magnet/i);
  });
});

describe("getBatchReadiness — the home-card snapshot (unlimited: no cooldown)", () => {
  test("counts available fresh sources; cooldown is always off now", async () => {
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [{ id: "lm1", text: "lm", post_url: null, post_type: "lead_magnet" }] };
      return { ok: true, posts: [
        { id: "r1", text: "one", post_url: null, post_type: "regular" },
        { id: "r2", text: "two", post_url: null, post_type: "regular" },
      ] };
    };
    const r = await getBatchReadiness("ws");
    expect(r.available).toBe(3); // 1 lead-magnet + 2 regular
    // Batches are unlimited (credit-cap gated) — readiness never reports cooldown.
    expect(r.cooldown.onCooldown).toBe(false);
  });

  test("available is 0 when there are no fresh posts", async () => {
    toolRef.current = () => ({ ok: true, posts: [] });
    const r = await getBatchReadiness("ws");
    expect(r.available).toBe(0);
  });
});

describe("settleStage — honest partial-batch message", () => {
  test("all drafted → plain 'Added N'", () => {
    expect(settleStage(6, 0)).toBe("6 drafts ready to review");
    expect(settleStage(1, 0)).toBe("1 draft ready to review");
  });
  test("partial → reports the shortfall", () => {
    expect(settleStage(4, 2)).toBe("4 drafts ready to review · 2 couldn't be adapted this time");
  });
  test("none drafted, some attempted → 'couldn't adapt any'", () => {
    expect(settleStage(0, 3)).toMatch(/couldn't adapt any/i);
  });
  test("none at all → generic", () => {
    expect(settleStage(0, 0)).toMatch(/couldn't draft anything/i);
  });
});

describe("runWeeklyBatch — a source the model can't adapt is an honest shortfall", () => {
  test("an unusable draft is skipped silently and reported in the settle stage (N of M)", async () => {
    // A too-short body means generateDraftBody returns null → the worker is a
    // no-op for that source (no slot row anymore); the gap surfaces only in the
    // settle stage, which stays honest about how many landed.
    chatQueue.push({ text: "no", finishReason: "stop" }, { text: "still no", finishReason: "stop" });
    dbRef.current = makeFakeSupabase({});
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "Regular hook", post_url: null, post_type: "regular" }] };
    };
    const res = await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1",
    });
    expect(res.drafts.length).toBe(0);
    expect(res.skipped).toBe(1);
    // No worker-lanes table is touched.
    expect(queryFor(dbRef.current, "batch_draft_slots")).toBeUndefined();
    // The settle stage owns the "couldn't adapt" message now.
    const stages = dbRef.current.queries
      .filter((q) => q.table === "batch_runs")
      .flatMap((q) => q.filters.filter((f) => f.method === "update"))
      .map((f) => (f.args[0] as { stage?: string }).stage)
      .filter((s): s is string => typeof s === "string");
    expect(stages.some((s) => /couldn't adapt/i.test(s))).toBe(true);
  });
});
