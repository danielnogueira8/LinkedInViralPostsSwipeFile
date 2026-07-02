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
  batchCooldown,
  selectSourcePosts,
  BATCH_COOLDOWN_MS,
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

describe("adaptedSourceIds — dedup source", () => {
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
});

describe("batchCooldown", () => {
  test("allowed when no prior batch draft", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: null } });
    expect(await batchCooldown("ws", 1_000_000_000)).toEqual({ allowed: true });
  });

  test("blocked within the window, returns the unlock time", async () => {
    const last = "2026-07-01T00:00:00.000Z";
    const lastMs = new Date(last).getTime();
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: { created_at: last } } });
    const res = await batchCooldown("ws", lastMs + 1000); // 1s later
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.retryAtIso).toBe(new Date(lastMs + BATCH_COOLDOWN_MS).toISOString());
  });

  test("allowed once the window has passed", async () => {
    const last = "2026-06-01T00:00:00.000Z";
    const lastMs = new Date(last).getTime();
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: { created_at: last } } });
    expect(await batchCooldown("ws", lastMs + BATCH_COOLDOWN_MS + 1)).toEqual({ allowed: true });
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
});
