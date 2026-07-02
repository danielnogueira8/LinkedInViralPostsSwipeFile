import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// The weekly-batch generation + persistence guards. A headless completeChat has
// none of the agent loop's render protections, so THIS is where we pin: em-dash
// stripping, length validation, the ONE truncation/short retry, usage
// accounting across attempts, source dedup, cooldown, and the workspace-scoped
// insert shape. We mock completeChat (canned model output), supabaseAdmin (the
// recording fake), and runTool (source posts). No network, no DB.
// ---------------------------------------------------------------------------

// completeChat responses, dequeued per call so a test can script a retry.
const chatQueue: Array<{
  text?: string;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  throw?: boolean; // simulate a transport error on this call
}> = [];
const chatCalls: Array<{ messages: unknown[] }> = [];

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    completeChat: async (opts: { messages: unknown[] }) => {
      chatCalls.push({ messages: opts.messages });
      const next = chatQueue.shift() ?? { text: "", finishReason: "stop" };
      if (next.throw) throw new Error("boom");
      return {
        text: next.text ?? "",
        toolArgs: null,
        finishReason: next.finishReason ?? "stop",
        usage: next.usage,
      };
    },
  };
});

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));

// runTool — canned source posts for get_top_from_batch.
const toolRef: { current: (name: string, args: unknown) => unknown } = {
  current: () => ({ ok: true, posts: [] }),
};
vi.mock("@/lib/agent/tools", () => ({
  runTool: async (name: string, args: unknown) => toolRef.current(name, args),
}));

const {
  generateDraftBody,
  insertBatchDraft,
  adaptedSourceIds,
  batchInFlight,
  selectSourcePosts,
  BATCH_RUN_STALE_MS,
} = await import("@/lib/batch/weekly");

beforeEach(() => {
  chatQueue.length = 0;
  chatCalls.length = 0;
  dbRef.current = makeFakeSupabase({});
  toolRef.current = () => ({ ok: true, posts: [] });
});

const SOURCE = { id: "p1", text: "A viral post about churn.", post_url: "https://x/p1", reactions: 500, post_type: "regular" };
const SYS = "system prompt";

describe("generateDraftBody — nets", () => {
  test("strips em-dashes from the model output before returning", async () => {
    // Body must clear MIN_DRAFT_BODY (120 chars) to be accepted, so pad it out.
    chatQueue.push({
      text:
        "Churn is quiet, until it isn't — and then it's everything you think about. " +
        "Most founders wait for the spike before they act, which is exactly the mistake.",
      finishReason: "stop",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const out = await generateDraftBody({ source: SOURCE, system: SYS, isLeadMagnet: false });
    expect(out.body).not.toBeNull();
    expect(out.body).not.toContain("—");
    expect(out.body).toContain("Churn is quiet");
  });

  test("rejects a too-short fragment, retries once, accepts the retry", async () => {
    chatQueue.push({ text: "Too short.", finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 3 } });
    chatQueue.push({
      text: "A".repeat(300),
      finishReason: "stop",
      usage: { prompt_tokens: 120, completion_tokens: 80 },
    });
    const out = await generateDraftBody({ source: SOURCE, system: SYS, isLeadMagnet: false });
    expect(chatCalls.length).toBe(2); // retried
    expect(out.body).toBe("A".repeat(300));
    // Usage accumulates across BOTH calls so the cost cap isn't under-counted.
    expect(out.usage).toEqual({ prompt_tokens: 220, completion_tokens: 83 });
  });

  test("truncated (finish_reason=length) triggers the retry", async () => {
    chatQueue.push({ text: "A".repeat(300), finishReason: "length", usage: { prompt_tokens: 100, completion_tokens: 2048 } });
    chatQueue.push({ text: "A".repeat(300), finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 200 } });
    const out = await generateDraftBody({ source: SOURCE, system: SYS, isLeadMagnet: false });
    expect(chatCalls.length).toBe(2);
    expect(out.body).toBe("A".repeat(300));
  });

  test("gives up after a second failure → body null, usage still counted", async () => {
    chatQueue.push({ text: "short", finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 2 } });
    chatQueue.push({ text: "also short", finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 3 } });
    const out = await generateDraftBody({ source: SOURCE, system: SYS, isLeadMagnet: false });
    expect(out.body).toBeNull();
    expect(out.usage).toEqual({ prompt_tokens: 200, completion_tokens: 5 });
  });

  test("a transport throw → body null (source skipped, no crash)", async () => {
    chatQueue.push({ throw: true });
    const out = await generateDraftBody({ source: SOURCE, system: SYS, isLeadMagnet: false });
    expect(out.body).toBeNull();
  });
});

describe("insertBatchDraft — workspace-scoped board row", () => {
  test("inserts a chat_id-null 'drafting' post with batch provenance in meta", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: { id: "d1", title: "t", body: "b" } } });
    const meta = {
      source: "weekly_batch" as const,
      batch_id: "batch-1",
      source_post_id: "p1",
      source_url: "https://x/p1",
      is_lead_magnet: false,
      generated_at: "2026-07-02T00:00:00.000Z",
    };
    const out = await insertBatchDraft({ workspaceId: "ws", body: "A real post body.", meta });
    expect(out).toEqual({ id: "d1", title: "t", body: "b" });

    const q = queryFor(dbRef.current, "chat_artifacts")!;
    const payload = q.filters.find((f) => f.method === "insert")!.args[0] as Record<string, unknown>;
    expect(payload.workspace_id).toBe("ws");
    expect(payload.chat_id).toBeNull();
    expect(payload.kind).toBe("post");
    expect(payload.status).toBe("drafting");
    expect(payload.meta).toEqual(meta);
  });
});

describe("adaptedSourceIds — recency-bounded dedup", () => {
  test("collects source_post_ids from prior batch drafts' meta", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: {
        rows: [
          { meta: { source_post_id: "p1" } },
          { meta: { source_post_id: "p2" } },
          { meta: {} },
          { meta: { source_post_id: null } },
        ],
      },
    });
    const ids = await adaptedSourceIds("ws");
    expect([...ids].sort()).toEqual(["p1", "p2"]);
  });

  test("filters by created_at >= the horizon so OLD adaptations stop counting", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [] } });
    await adaptedSourceIds("ws");
    const q = queryFor(dbRef.current, "chat_artifacts")!;
    const gte = q.filters.find((f) => f.method === "gte" && f.args[0] === "created_at");
    expect(gte).toBeDefined(); // the recency-horizon filter is applied
  });
});

describe("batchInFlight — guard against overlapping runs (NOT a cooldown)", () => {
  test("false when there's no active run", async () => {
    dbRef.current = makeFakeSupabase({ batch_runs: { single: null } });
    expect(await batchInFlight("ws", Date.now())).toBe(false);
  });

  test("true when a run is pending/running and fresh", async () => {
    const updated = "2026-07-02T00:00:00.000Z";
    const updatedMs = new Date(updated).getTime();
    dbRef.current = makeFakeSupabase({
      batch_runs: { single: { status: "running", updated_at: updated } },
    });
    expect(await batchInFlight("ws", updatedMs + 1000)).toBe(true); // 1s later
  });

  test("false when the active run is STALE (its after() died) — a retry isn't blocked", async () => {
    const updated = "2026-07-02T00:00:00.000Z";
    const updatedMs = new Date(updated).getTime();
    dbRef.current = makeFakeSupabase({
      batch_runs: { single: { status: "running", updated_at: updated } },
    });
    expect(await batchInFlight("ws", updatedMs + BATCH_RUN_STALE_MS + 1)).toBe(false);
  });

  test("queries only pending/running rows, workspace-scoped", async () => {
    dbRef.current = makeFakeSupabase({ batch_runs: { single: null } });
    await batchInFlight("ws", Date.now());
    const q = dbRef.current.queries.find((x) => x.table === "batch_runs")!;
    const inFilter = q.filters.find((f) => f.method === "in");
    expect(inFilter?.args[1]).toEqual(["pending", "running"]);
    expect(q.filters.some((f) => f.method === "eq" && f.args[0] === "workspace_id")).toBe(true);
  });
});

describe("selectSourcePosts — dedup + lead-magnet reservation", () => {
  test("excludes already-adapted posts and reserves a lead-magnet slot", async () => {
    // adaptedSourceIds reads chat_artifacts (meta) — return p1 as already used.
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { rows: [{ meta: { source_post_id: "p-used" } }] },
    });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") {
        return { ok: true, posts: [{ id: "lm1", text: "lead magnet", post_url: null, post_type: "lead_magnet" }] };
      }
      // regular: include the already-used id (must be filtered) + fresh ones.
      return {
        ok: true,
        posts: [
          { id: "p-used", text: "used", post_url: null, post_type: "regular" },
          { id: "r1", text: "fresh one", post_url: null, post_type: "regular" },
          { id: "r2", text: "fresh two", post_url: null, post_type: "regular" },
        ],
      };
    };
    const { regular, leadMagnet } = await selectSourcePosts("ws");
    expect(leadMagnet.map((p) => p.id)).toEqual(["lm1"]);
    expect(regular.map((p) => p.id)).not.toContain("p-used"); // deduped
    expect(regular.length).toBeGreaterThan(0);
  });

  test("BACK-FILLS from a 30-day window when the fresh 7-day pool is short of target", async () => {
    // The 6-of-4 bug: the 7-day window returns only a few, so the batch settled
    // short. Now, when under BATCH_DRAFT_COUNT, it re-pulls with window_days: 30.
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [] } });
    const windowsSeen: number[] = [];
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string; window_days?: number };
      windowsSeen.push(a.window_days ?? 7);
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      // 7-day window: only 2 fresh regulars. 30-day window: 5 more.
      if (a.window_days === 30) {
        return {
          ok: true,
          posts: Array.from({ length: 5 }, (_, i) => ({
            id: `w${i}`, text: `wide ${i}`, post_url: null, post_type: "regular",
          })),
        };
      }
      return {
        ok: true,
        posts: [
          { id: "r1", text: "fresh one", post_url: null, post_type: "regular" },
          { id: "r2", text: "fresh two", post_url: null, post_type: "regular" },
        ],
      };
    };
    const { regular } = await selectSourcePosts("ws");
    // A 30-day back-fill pull actually happened.
    expect(windowsSeen).toContain(30);
    // The batch now reaches the full target (2 fresh + back-fill = 6), not 2.
    expect(regular.length).toBe(6);
    // The fresh ones come first, back-fill after; no dupes.
    expect(new Set(regular.map((p) => p.id)).size).toBe(6);
    expect(regular.slice(0, 2).map((p) => p.id)).toEqual(["r1", "r2"]);
  });

  test("recency-bounded dedup: an OLD adapted post no longer blocks re-adapting", async () => {
    // adaptedSourceIds now filters chat_artifacts by created_at >= horizon, so an
    // ancient row simply isn't returned by the query (the fake returns what we
    // give it). Here: no recent adapted rows → nothing excluded → full fresh set.
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [] } });
    toolRef.current = (name, args) => {
      const a = args as { post_type?: string };
      if (a.post_type === "lead_magnet") return { ok: true, posts: [] };
      return {
        ok: true,
        posts: Array.from({ length: 6 }, (_, i) => ({
          id: `r${i}`, text: `post ${i}`, post_url: null, post_type: "regular",
        })),
      };
    };
    const { regular } = await selectSourcePosts("ws");
    expect(regular.length).toBe(6);
  });
});
