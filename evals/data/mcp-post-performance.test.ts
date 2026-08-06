import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

// End-to-end cover for the get_post_performance MCP tool: that it is actually
// REGISTERED (a tool nobody can call is not a feature), that it is scoped to
// the caller's workspace on BOTH reads, and that the envelope it returns says
// what it means.
//
// The fold arithmetic itself is covered by post-performance.test.ts; this file
// is about the wiring around it.

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIdsForService: async () => [],
  latestRelevantScrapeForService: async () => null,
}));
vi.mock("@/lib/ai-operation-claims", () => ({
  claimAiOperation: async () => "claim-1",
  releaseAiOperation: async () => undefined,
}));
vi.mock("@/lib/agent/rate-limit", () => ({
  VOICE_JOB_COST_RESERVE_USD: 0.2,
  checkChatCostAllowance: async () => ({ ok: true }),
  checkChatRateLimit: async () => ({ ok: true }),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: async () => ({ id: "job-1" }),
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
type ToolConfig = { description?: string; inputSchema?: Record<string, unknown> };

function registry() {
  const handlers: Record<string, ToolHandler> = {};
  const configs: Record<string, ToolConfig> = {};
  registerSwipeTools({
    registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => {
      handlers[name] = handler;
      configs[name] = config;
    },
  } as never);
  return { handlers, configs };
}

function extra(workspaceId: string | null = "ws-1") {
  return { authInfo: { extra: { workspaceId, userId: "user-1" } } };
}

function json(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

const ARTIFACTS = [
  {
    id: "a1",
    title: "Teardown post",
    body: "Long teardown body",
    published_at: "2026-08-01T10:00:00Z",
    kind: "post",
  },
  {
    id: "a2",
    title: "Lead magnet post",
    body: "Comment GUIDE",
    published_at: "2026-08-02T10:00:00Z",
    kind: "lead_magnet",
  },
];

// a1 has two snapshots: cumulative, so only the newest counts.
const SNAPSHOTS = [
  {
    artifact_id: "a1",
    snapshot_date: "2026-08-02",
    impressions: 1_000,
    reach: 900,
    likes: 10,
    comments: 2,
    shares: 1,
    saves: 0,
    sends: 0,
  },
  {
    artifact_id: "a1",
    snapshot_date: "2026-08-06",
    impressions: 5_000,
    reach: 4_000,
    likes: 200,
    comments: 40,
    shares: 10,
    saves: 5,
    sends: 5,
  },
  {
    artifact_id: "a2",
    snapshot_date: "2026-08-06",
    impressions: 2_000,
    reach: 1_800,
    likes: 20,
    comments: 4,
    shares: 0,
    saves: 0,
    sends: 0,
  },
];

function seed(over: Partial<Record<string, unknown[]>> = {}) {
  dbRef.current = makeFakeSupabase({
    chat_artifacts: { rows: (over.chat_artifacts ?? ARTIFACTS) as never },
    post_analytics: { rows: (over.post_analytics ?? SNAPSHOTS) as never },
  });
}

beforeEach(() => seed());

describe("get_post_performance — registration", () => {
  test("is registered on the MCP surface", () => {
    // Without this, everything else in this file could pass while the tool is
    // unreachable from an actual client.
    expect(Object.keys(registry().handlers)).toContain("get_post_performance");
  });

  test("its description tells a model when to reach for it", () => {
    const description = registry().configs.get_post_performance?.description ?? "";
    expect(description).toMatch(/engagement rate/i);
    // The point of the tool is grounding advice in THIS author's results.
    expect(description).toMatch(/this author/i);
  });
});

describe("get_post_performance — tenancy", () => {
  test("refuses when the caller has no workspace", async () => {
    const result = await registry().handlers.get_post_performance({}, extra(null));
    expect(json(result).ok).toBe(false);
  });

  test("scopes BOTH reads to the caller's workspace", async () => {
    await registry().handlers.get_post_performance({}, extra("ws-1"));
    // A missing workspace filter on either table would leak another
    // workspace's performance data through the MCP surface.
    for (const table of ["chat_artifacts", "post_analytics"]) {
      const filters = queryFor(dbRef.current, table)?.filters ?? [];
      const scoped = filters.some(
        (f) => f.method === "eq" && f.args[0] === "workspace_id" && f.args[1] === "ws-1",
      );
      expect(scoped, `${table} must filter on workspace_id`).toBe(true);
    }
  });

  test("only reads posts that were actually published", async () => {
    await registry().handlers.get_post_performance({}, extra());
    const filters = queryFor(dbRef.current, "chat_artifacts")?.filters ?? [];
    expect(
      filters.some(
        (f) =>
          f.method === "eq" &&
          f.args[0] === "schedule_status" &&
          f.args[1] === "published",
      ),
    ).toBe(true);
  });
});

describe("get_post_performance — results", () => {
  test("returns one row per post using its newest snapshot", async () => {
    const body = await registry()
      .handlers.get_post_performance({}, extra())
      .then(json);
    expect(body.ok).toBe(true);
    const posts = body.posts as Array<Record<string, unknown>>;
    expect(posts).toHaveLength(2);
    const a1 = posts.find((p) => p.artifact_id === "a1")!;
    // 5000, not 6000 (the two snapshots summed) and not 1000 (the older one).
    expect(a1.impressions).toBe(5_000);
    expect(a1.engagements).toBe(260);
    expect(a1.measured_on).toBe("2026-08-06");
  });

  test("totals describe the whole window, not the truncated page", async () => {
    // Otherwise `limit: 1` would silently redefine the workspace's average.
    const body = await registry()
      .handlers.get_post_performance({ limit: 1 }, extra())
      .then(json);
    expect((body.posts as unknown[]).length).toBe(1);
    expect((body.totals as Record<string, unknown>).posts).toBe(2);
    expect((body.totals as Record<string, unknown>).impressions).toBe(7_000);
  });

  test("sorts by the requested metric", async () => {
    const body = await registry()
      .handlers.get_post_performance({ sort: "engagements", dir: "desc" }, extra())
      .then(json);
    expect((body.posts as Array<Record<string, unknown>>)[0].artifact_id).toBe("a1");
  });

  test("filters to lead magnets at the query level", async () => {
    await registry().handlers.get_post_performance(
      { post_type: "lead_magnet" },
      extra(),
    );
    const filters = queryFor(dbRef.current, "chat_artifacts")?.filters ?? [];
    expect(
      filters.some(
        (f) => f.method === "eq" && f.args[0] === "kind" && f.args[1] === "lead_magnet",
      ),
    ).toBe(true);
  });

  test("regular excludes lead magnets rather than assuming one kind string", async () => {
    await registry().handlers.get_post_performance({ post_type: "regular" }, extra());
    const filters = queryFor(dbRef.current, "chat_artifacts")?.filters ?? [];
    expect(
      filters.some(
        (f) => f.method === "neq" && f.args[0] === "kind" && f.args[1] === "lead_magnet",
      ),
    ).toBe(true);
  });

  test("applies a publish-date window by default and drops it for 'all'", async () => {
    await registry().handlers.get_post_performance({}, extra());
    expect(
      (queryFor(dbRef.current, "chat_artifacts")?.filters ?? []).some(
        (f) => f.method === "gte" && f.args[0] === "published_at",
      ),
    ).toBe(true);

    seed();
    await registry().handlers.get_post_performance({ since: "all" }, extra());
    expect(
      (queryFor(dbRef.current, "chat_artifacts")?.filters ?? []).some(
        (f) => f.method === "gte" && f.args[0] === "published_at",
      ),
    ).toBe(false);
  });

  test("returns ok with an empty list when nothing is published", async () => {
    // An empty workspace is a normal state, not an error — a client should be
    // able to branch on `posts.length`, not on parsing an error string.
    seed({ chat_artifacts: [] });
    const body = await registry()
      .handlers.get_post_performance({}, extra())
      .then(json);
    expect(body.ok).toBe(true);
    expect(body.posts).toEqual([]);
    expect((body.totals as Record<string, unknown>).posts).toBe(0);
  });

  test("omits published posts that have no snapshot yet", async () => {
    seed({ post_analytics: [] });
    const body = await registry()
      .handlers.get_post_performance({}, extra())
      .then(json);
    expect(body.ok).toBe(true);
    expect(body.posts).toEqual([]);
  });

  test("never returns a raw driver error to the caller", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { error: { message: 'column "secret_internal" does not exist' } },
    });
    const body = await registry()
      .handlers.get_post_performance({}, extra())
      .then(json);
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret_internal");
  });
});
