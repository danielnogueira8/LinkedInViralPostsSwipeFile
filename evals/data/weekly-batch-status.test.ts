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
    completeChat: async (opts: { messages?: Array<{ content?: string }> }) => {
      const next = chatQueue.shift();
      if (next) {
        return { text: next.text ?? "A".repeat(300), toolArgs: null, finishReason: next.finishReason ?? "stop", usage: { prompt_tokens: 10, completion_tokens: 10 } };
      }
      const transcript = (opts.messages ?? []).map((m) => m.content ?? "").join("\n");
      const text = transcript.includes("UNADAPTABLE_SOURCE")
        ? "no"
        : `${"A".repeat(300)} checklist prompt story created generated profile banner pack body`;
      return { text, toolArgs: null, finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 10 } };
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

const trackedAccountIdsRef: { current: string[] } = { current: ["acct-1"] };
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => trackedAccountIdsRef.current,
}));

const createdLeadMagnetCalls: unknown[] = [];
vi.mock("@/lib/lead-magnet-ai", () => ({
  generateLeadMagnetResource: async (opts: unknown) => {
    createdLeadMagnetCalls.push(opts);
    return {
      leadMagnet: {
        id: `created-lm-${createdLeadMagnetCalls.length}`,
        workspace_id: "ws",
        user_id: "user-1",
        title: `Created Lead Magnet ${createdLeadMagnetCalls.length}`,
        markdown_body: "Generated markdown body",
        source_url: null,
        source_type: "ai",
        public_slug: `created-lead-magnet-${createdLeadMagnetCalls.length}`,
        is_public: true,
        metadata: {
          selection_summary: "A generated resource for this post.",
          deliverables: ["Generated checklist"],
        },
        created_at: "2026-07-02T00:00:00.000Z",
        updated_at: "2026-07-02T00:00:00.000Z",
      },
      used: createdLeadMagnetCalls.length,
      limit: 10,
    };
  },
}));

const queuedImageCalls: unknown[] = [];
vi.mock("@/lib/lead-magnet-image-jobs", () => ({
  enqueueLeadMagnetImageJob: async (opts: {
    sourceImage?: { postId?: string };
    leadMagnet?: { id?: string | null; title?: string };
  }) => {
    queuedImageCalls.push(opts);
    return {
      jobId: "image-job-1",
      queuedMeta: {
        status: "queued",
        job_id: "image-job-1",
        source_post_id: opts.sourceImage?.postId ?? null,
        lead_magnet_id: opts.leadMagnet?.id ?? null,
        lead_magnet_title: opts.leadMagnet?.title ?? null,
      },
    };
  },
}));

const {
  createBatchRun,
  claimBatchRun,
  createBatchChat,
  updateBatchRun,
  latestBatchRun,
  runWeeklyBatch,
  getBatchReadiness,
  batchSlots,
  firstLine,
  settleStage,
  BATCH_RUN_STALE_MS,
} = await import("@/lib/batch/weekly");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  chatQueue.length = 0;
  toolRef.current = () => ({ ok: true, posts: [] });
  trackedAccountIdsRef.current = ["acct-1"];
  createdLeadMagnetCalls.length = 0;
  queuedImageCalls.length = 0;
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

  test("identifies the unique active-run conflict", async () => {
    dbRef.current = makeFakeSupabase({
      batch_runs: { error: { message: "duplicate", code: "23505" } as never },
    });
    await expect(claimBatchRun("ws", "batch-2")).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
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

  test("with sources → publishes finding → dispatched N → added stages, and writes worker slots", async () => {
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
    // Per-worker slots are created up front and advanced to 'filed'.
    const slotWrites = dbRef.current.queries.filter((q) => q.table === "batch_draft_slots");
    expect(slotWrites.some((q) => q.filters.some((f) => f.method === "insert"))).toBe(true);
    const updates = slotWrites.flatMap((q) => q.filters.filter((f) => f.method === "update"));
    const statuses = updates.map((u) => (u.args[0] as { status?: string }).status);
    expect(statuses).toContain("drafting");
    expect(statuses).toContain("filed");
  });

  test("publishes granular setup stages so the chat strip advances (feedback fix)", async () => {
    // Before the fix the strip sat on "Finding this week's top posts" for the
    // whole ~30-60s setup phase and read as frozen. Now the run walks through
    // distinct stages the activity strip can show moving.
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "t", body: "b" } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "fresh source post text here", post_url: null, post_type: "regular" }] };
    };
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1",
    });
    const stages = stagesWritten();
    // Distinct pre-dispatch stages, each a separate line the strip can render.
    expect(stages.some((s) => /voice profile/i.test(s))).toBe(true);
    expect(stages.some((s) => /finding/i.test(s))).toBe(true);
    expect(stages.some((s) => /setting up your writers/i.test(s))).toBe(true);
    expect(stages.some((s) => /dispatched 1 writer/i.test(s))).toBe(true);
  });

  test("writes a visible 'found N posts' transcript line at dispatch (feedback fix)", async () => {
    // A persisted chat message — not just the strip — is what the user reads as
    // "the batch actually started." It must land BEFORE the first draft.
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "t", body: "b" } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "fresh source post text here", post_url: null, post_type: "regular" }] };
    };
    await runWeeklyBatch({
      workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1", chatId: "chat-9",
    });
    const msgContents = dbRef.current.queries
      .filter((q) => q.table === "chat_messages")
      .flatMap((q) => q.filters.filter((f) => f.method === "insert").map((f) => f.args[0] as Record<string, unknown>))
      .map((m) => String(m.content ?? ""));
    // The dispatch line names the count and sets expectations.
    expect(msgContents.some((c) => /found 1 post to adapt/i.test(c))).toBe(true);
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

describe("worker slots — firstLine + slot lifecycle", () => {
  test("firstLine takes the first non-empty line and clamps it", () => {
    expect(firstLine("  \n\nThe hook line here\nmore body")).toBe("The hook line here");
    expect(firstLine("x".repeat(200)).length).toBeLessThanOrEqual(90);
    expect(firstLine("")).toBe("");
    expect(firstLine(null)).toBe("");
  });

  test("createBatchSlots seeds a lane per source with its source + skill label", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "t", body: "b" } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet")
        return { ok: true, posts: [{ id: "lm1", text: "Giveaway hook", post_url: "u", post_type: "lead_magnet" }] };
      return { ok: true, posts: [{ id: "r1", text: "Regular hook line", post_url: null, post_type: "regular" }] };
    };
    await runWeeklyBatch({ workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1" });
    const insert = dbRef.current.queries
      .filter((q) => q.table === "batch_draft_slots")
      .flatMap((q) => q.filters.filter((f) => f.method === "insert"))[0];
    const rows = insert.args[0] as Array<Record<string, unknown>>;
    // Lead-magnet lane first, then regular — each with its post-type label.
    expect(rows.map((r) => r.skill_label)).toEqual(["Lead Magnet Post", "Regular Post"]);
    expect(rows.map((r) => r.source_first_line)).toEqual(["Giveaway hook", "Regular hook line"]);
    expect(rows.every((r) => r.status === "queued")).toBe(true);
  });

  test("a short first regular source backfills and still files the slot", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "Filed draft", body: "A".repeat(300) } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return {
        ok: true,
        posts: [
          { id: "r-bad", text: "UNADAPTABLE_SOURCE", post_url: null, post_type: "regular" },
          { id: "r2", text: "Regular hook 2", post_url: null, post_type: "regular" },
          { id: "r3", text: "Regular hook 3", post_url: null, post_type: "regular" },
          { id: "r4", text: "Regular hook 4", post_url: null, post_type: "regular" },
          { id: "r5", text: "Regular hook 5", post_url: null, post_type: "regular" },
          { id: "r-backfill", text: "Regular replacement hook", post_url: null, post_type: "regular" },
        ],
      };
    };
    await runWeeklyBatch({ workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1" });

    const updates = dbRef.current.queries
      .filter((q) => q.table === "batch_draft_slots")
      .flatMap((q) => q.filters.filter((f) => f.method === "update"))
      .map((u) => u.args[0] as { status?: string; source_post_id?: string; error?: string });
    expect(updates.some((u) => u.source_post_id === "r-backfill" && u.status === "drafting")).toBe(true);
    expect(updates.map((u) => u.status)).not.toContain("skipped");
    expect(updates.filter((u) => u.status === "filed").length).toBe(5);
  });

  test("lead-magnet slots backfill only from lead-magnet candidates", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "Filed draft", body: "A".repeat(300) } },
      lead_magnets: {
        rows: [{
          id: "lm-resource",
          workspace_id: "ws",
          user_id: "user-1",
          title: "Profile Checklist",
          markdown_body: "# Profile Checklist\n\n- Profile review steps",
          source_url: null,
          source_type: "ai",
          public_slug: "profile-checklist",
          is_public: true,
          metadata: { deliverables: ["Profile review steps"] },
          created_at: "2026-07-02T00:00:00.000Z",
          updated_at: "2026-07-02T00:00:00.000Z",
        }],
      },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") {
        return {
          ok: true,
          posts: [
            { id: "lm-bad", text: "UNADAPTABLE_SOURCE", post_url: null, post_type: "lead_magnet" },
            { id: "lm2", text: "Lead magnet hook 2", post_url: null, post_type: "lead_magnet" },
            { id: "lm-backfill", text: "Lead magnet replacement hook", post_url: null, post_type: "lead_magnet" },
          ],
        };
      }
      return {
        ok: true,
        posts: Array.from({ length: 6 }, (_, i) => ({
          id: `r${i}`,
          text: `Regular hook ${i}`,
          post_url: null,
          post_type: "regular",
        })),
      };
    };
    await runWeeklyBatch({ workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1" });

    const updates = dbRef.current.queries
      .filter((q) => q.table === "batch_draft_slots")
      .flatMap((q) => q.filters.filter((f) => f.method === "update"))
      .map((u) => u.args[0] as { status?: string; source_post_id?: string; post_type?: string });
    expect(updates).toContainEqual(expect.objectContaining({
      status: "drafting",
      source_post_id: "lm-backfill",
      post_type: "lead_magnet",
    }));
    expect(updates).not.toContainEqual(expect.objectContaining({
      status: "drafting",
      source_post_id: "r0",
      post_type: "lead_magnet",
    }));
  });

  test("regular slots backfill only from regular candidates", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "Filed draft", body: "A".repeat(300) } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") {
        return {
          ok: true,
          posts: [
            { id: "lm1", text: "Lead magnet hook 1", post_url: null, post_type: "lead_magnet" },
            { id: "lm2", text: "Lead magnet hook 2", post_url: null, post_type: "lead_magnet" },
            { id: "lm-extra", text: "Lead magnet reserve", post_url: null, post_type: "lead_magnet" },
          ],
        };
      }
      return {
        ok: true,
        posts: [
          { id: "r-bad", text: "UNADAPTABLE_SOURCE", post_url: null, post_type: "regular" },
          { id: "r2", text: "Regular hook 2", post_url: null, post_type: "regular" },
          { id: "r3", text: "Regular hook 3", post_url: null, post_type: "regular" },
          { id: "r4", text: "Regular hook 4", post_url: null, post_type: "regular" },
          { id: "r5", text: "Regular hook 5", post_url: null, post_type: "regular" },
          { id: "r-backfill", text: "Regular replacement hook", post_url: null, post_type: "regular" },
        ],
      };
    };
    await runWeeklyBatch({ workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1" });

    const updates = dbRef.current.queries
      .filter((q) => q.table === "batch_draft_slots")
      .flatMap((q) => q.filters.filter((f) => f.method === "update"))
      .map((u) => u.args[0] as { status?: string; source_post_id?: string; post_type?: string });
    expect(updates).toContainEqual(expect.objectContaining({
      status: "drafting",
      source_post_id: "r-backfill",
      post_type: "regular",
    }));
    expect(updates).not.toContainEqual(expect.objectContaining({
      status: "drafting",
      source_post_id: "lm-extra",
      post_type: "regular",
    }));
  });

  test("a source the model can't adapt reports exhaustion only when no same-type candidates remain", async () => {
    dbRef.current = makeFakeSupabase({});
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return { ok: true, posts: [{ id: "r1", text: "UNADAPTABLE_SOURCE", post_url: null, post_type: "regular" }] };
    };
    await runWeeklyBatch({ workspaceId: "ws", batchId: "b1", nowIso: "2026-07-02T00:00:00.000Z", runId: "run-1" });
    const updates = dbRef.current.queries
      .filter((q) => q.table === "batch_draft_slots")
      .flatMap((q) => q.filters.filter((f) => f.method === "update"))
      .map((u) => u.args[0] as { status?: string; error?: string });
    expect(updates.map((u) => u.status)).toContain("skipped");
    expect(updates.map((u) => u.error).filter(Boolean).join("\n")).toMatch(/No more same-type source posts/);
  });

  test("lead-magnet batch drafts auto-select a saved resource without image work", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "Draft title", body: "A".repeat(300) } },
      lead_magnets: {
        rows: [{
          id: "lm-resource",
          workspace_id: "ws",
          user_id: "user-1",
          title: "Story Tweet Prompt Pack",
          markdown_body: "body",
          source_url: null,
          source_type: "ai",
          public_slug: "story-tweet-prompt-pack",
          is_public: true,
          metadata: { selection_summary: "Personal story tweet prompts.", deliverables: ["Prompt pack"] },
          created_at: "2026-07-02T00:00:00.000Z",
          updated_at: "2026-07-02T00:00:00.000Z",
        }],
      },
      posts: { single: { id: "lm1", media_type: "document", media_urls: ["https://cdn.test/doc-cover.png"] } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet")
        return { ok: true, posts: [{ id: "lm1", text: "Give away a story prompt pack", post_url: "u", post_type: "lead_magnet" }] };
      return { ok: true, posts: [] };
    };

    await runWeeklyBatch({
      workspaceId: "ws",
      userId: "user-1",
      batchId: "b1",
      nowIso: "2026-07-02T00:00:00.000Z",
      runId: "run-1",
      chatId: "chat-1",
    });

    const insertPayload = dbRef.current.queries
      .filter((q) => q.table === "chat_artifacts")
      .flatMap((q) => q.filters.filter((f) => f.method === "insert"))
      .map((f) => f.args[0] as { meta?: Record<string, unknown> })
      .find((p) => p.meta?.source === "weekly_batch")!;
    expect(insertPayload.meta?.lead_magnet).toEqual(expect.objectContaining({
      id: "lm-resource",
      title: "Story Tweet Prompt Pack",
      public_slug: "story-tweet-prompt-pack",
      selection: "auto",
    }));

    const updatePayloads = dbRef.current.queries
      .filter((q) => q.table === "chat_artifacts")
      .flatMap((q) => q.filters.filter((f) => f.method === "update"))
      .map((f) => f.args[0] as { meta?: Record<string, unknown> });
    expect(
      updatePayloads.some((payload) => payload.meta?.generated_lead_magnet_image),
    ).toBe(false);
    expect(queuedImageCalls.length).toBe(0);
  });

  test("no saved lead magnets creates one resource per lead-magnet draft", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "Draft title", body: "A".repeat(300) } },
      lead_magnets: { rows: [] },
      posts: { single: { id: "lm1", media_type: "none", media_urls: [] } },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet")
        return { ok: true, posts: [
          { id: "lm1", text: "Give away prompt pack one", post_url: "u1", post_type: "lead_magnet" },
          { id: "lm2", text: "Give away prompt pack two", post_url: "u2", post_type: "lead_magnet" },
        ] };
      return { ok: true, posts: [] };
    };

    await runWeeklyBatch({
      workspaceId: "ws",
      userId: "user-1",
      batchId: "b1",
      nowIso: "2026-07-02T00:00:00.000Z",
      runId: "run-1",
    });

    expect(createdLeadMagnetCalls.length).toBe(2);
    const leadMagnetMeta = dbRef.current.queries
      .filter((q) => q.table === "chat_artifacts")
      .flatMap((q) => q.filters.filter((f) => f.method === "insert"))
      .map((f) => (f.args[0] as { meta?: Record<string, unknown> }).meta?.lead_magnet)
      .filter(Boolean);
    expect(leadMagnetMeta).toHaveLength(2);
    expect(leadMagnetMeta[0]).toEqual(expect.objectContaining({
      id: "created-lm-1",
      public_slug: "created-lead-magnet-1",
    }));
    expect(leadMagnetMeta[1]).toEqual(expect.objectContaining({
      id: "created-lm-2",
      public_slug: "created-lead-magnet-2",
    }));
  });

  test("eligible lead-magnet source images do not queue automatic generation", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { id: "d1", title: "Draft title", body: "A".repeat(300) } },
      lead_magnets: {
        rows: [{
          id: "lm-resource",
          workspace_id: "ws",
          user_id: "user-1",
          title: "Prompt Pack",
          markdown_body: "body",
          source_url: null,
          source_type: "ai",
          public_slug: "prompt-pack",
          is_public: true,
          metadata: { selection_summary: "Prompt pack.", deliverables: ["Prompt pack"] },
          created_at: "2026-07-02T00:00:00.000Z",
          updated_at: "2026-07-02T00:00:00.000Z",
        }],
      },
      posts: { single: { id: "lm1", media_type: "image", media_urls: ["https://cdn.test/source.png"] } },
      usage_events: { rows: [] },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet")
        return { ok: true, posts: [{ id: "lm1", text: "Give away a prompt pack", post_url: "u", post_type: "lead_magnet" }] };
      return { ok: true, posts: [] };
    };

    await runWeeklyBatch({
      workspaceId: "ws",
      userId: "user-1",
      batchId: "b1",
      nowIso: "2026-07-02T00:00:00.000Z",
      runId: "run-1",
    });

    expect(queuedImageCalls.length).toBe(0);
    const updatePayloads = dbRef.current.queries
      .filter((q) => q.table === "chat_artifacts")
      .flatMap((q) => q.filters.filter((f) => f.method === "update"))
      .map((f) => f.args[0] as { media_attachments?: unknown[]; meta?: Record<string, unknown> });
    expect(
      updatePayloads.some((payload) => payload.meta?.generated_lead_magnet_image),
    ).toBe(false);
  });

  test("batchSlots reads a run's slots workspace-scoped, ordered by slot_index", async () => {
    dbRef.current = makeFakeSupabase({
      batch_draft_slots: { rows: [{ id: "s1", slot_index: 0 }, { id: "s2", slot_index: 1 }] },
    });
    const slots = await batchSlots("ws", "b1");
    expect(slots.length).toBe(2);
    const q = queryFor(dbRef.current, "batch_draft_slots")!;
    const eqs = q.filters.filter((f) => f.method === "eq").map((f) => f.args[0]);
    expect(eqs).toContain("workspace_id");
    expect(eqs).toContain("batch_id");
    expect(q.filters.find((f) => f.method === "order")?.args[0]).toBe("slot_index");
  });
});
