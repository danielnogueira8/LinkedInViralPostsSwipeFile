import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

// Wiring cover for analyze_posts. The pattern maths is tested in
// post-pattern-analysis.test.ts; this file is about the parts that only exist
// once the function is a TOOL: registration, tenancy, and whether the envelope
// lets a caller tell how much of what they asked for was actually covered.

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
const trackedRef: { current: string[] } = { current: ["acc-1"] };

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIdsForService: async () => trackedRef.current,
  trackedAccountIds: async () => trackedRef.current,
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

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_MISSING = "33333333-3333-4333-8333-333333333333";

const POSTS = [
  { id: ID_A, text: "3 lessons from my first startup\n\nBody here.", reactions: 100, comments: 20 },
  { id: ID_B, text: "5 ways to close faster\n\nBody here.", reactions: 40, comments: 10 },
];

function seed(rows: unknown[] = POSTS) {
  dbRef.current = makeFakeSupabase({ posts: { rows: rows as never } });
}

beforeEach(() => {
  trackedRef.current = ["acc-1"];
  seed();
});

describe("analyze_posts — registration", () => {
  test("is registered on the MCP surface", () => {
    expect(Object.keys(registry().handlers)).toContain("analyze_posts");
  });

  test("its description promises determinism", () => {
    // The reason to call this instead of eyeballing examples is that it returns
    // the same answer every time; a client should be told so.
    const description = registry().configs.analyze_posts?.description ?? "";
    expect(description).toMatch(/identical results|measured, not estimated/i);
  });
});

describe("analyze_posts — tenancy", () => {
  test("refuses when the caller has no workspace", async () => {
    const body = await registry()
      .handlers.analyze_posts({ post_ids: [ID_A] }, extra(null))
      .then(json);
    expect(body.ok).toBe(false);
  });

  test("restricts the read to the workspace's tracked accounts", async () => {
    await registry().handlers.analyze_posts({ post_ids: [ID_A] }, extra());
    const filters = queryFor(dbRef.current, "posts")?.filters ?? [];
    // The corpus table is shared across workspaces. Without this predicate a
    // caller could analyze any post id in the system.
    expect(
      filters.some((f) => f.method === "in" && f.args[0] === "account_id"),
    ).toBe(true);
  });

  test("returns an empty analysis when the workspace tracks nobody", async () => {
    trackedRef.current = [];
    const body = await registry()
      .handlers.analyze_posts({ post_ids: [ID_A] }, extra())
      .then(json);
    expect(body.ok).toBe(true);
    expect(body.analyzed_posts).toBe(0);
  });
});

describe("analyze_posts — results", () => {
  test("reports the shared hook pattern across the set", async () => {
    const body = await registry()
      .handlers.analyze_posts({ post_ids: [ID_A, ID_B] }, extra())
      .then(json);
    expect(body.ok).toBe(true);
    expect(body.analyzed_posts).toBe(2);
    const patterns = body.hook_patterns as Array<Record<string, unknown>>;
    expect(patterns[0].pattern).toBe("numbered_promise");
    expect(patterns[0].posts).toBe(2);
  });

  test("reports requested and analyzed counts separately", async () => {
    // Asking about 3 posts and getting 2 back (one id belongs to another
    // workspace, or was deleted) must be visible — otherwise the caller reads
    // the analysis as covering all 3.
    const body = await registry()
      .handlers.analyze_posts({ post_ids: [ID_A, ID_B, ID_MISSING] }, extra())
      .then(json);
    expect(body.requested_posts).toBe(3);
    expect(body.analyzed_posts).toBe(2);
  });

  test("includes structure and mechanics alongside hooks", async () => {
    const body = await registry()
      .handlers.analyze_posts({ post_ids: [ID_A, ID_B] }, extra())
      .then(json);
    expect(body.structure).toBeTruthy();
    expect(body.mechanics).toBeTruthy();
    expect((body.structure as Record<string, unknown>).median_words).toBeGreaterThan(0);
  });

  test("weights hook patterns by engagement drawn from the posts", async () => {
    const body = await registry()
      .handlers.analyze_posts({ post_ids: [ID_A, ID_B] }, extra())
      .then(json);
    const patterns = body.hook_patterns as Array<Record<string, unknown>>;
    // (100+20) and (40+10) → mean 85.
    expect(patterns[0].avg_engagement).toBe(85);
  });

  test("survives posts with a null body", async () => {
    seed([{ id: ID_A, text: null, reactions: 0, comments: 0 }]);
    const body = await registry()
      .handlers.analyze_posts({ post_ids: [ID_A] }, extra())
      .then(json);
    expect(body.ok).toBe(true);
    expect(body.analyzed_posts).toBe(0);
  });

  test("caps how many ids can be requested at once", () => {
    const schema = registry().configs.analyze_posts?.inputSchema as
      | Record<string, { safeParse?: (v: unknown) => { success: boolean } }>
      | undefined;
    const parsed = schema?.post_ids?.safeParse?.(
      Array.from({ length: 51 }, () => ID_A),
    );
    expect(parsed?.success).toBe(false);
  });

  test("never returns a raw driver error to the caller", async () => {
    dbRef.current = makeFakeSupabase({
      posts: { error: { message: 'column "secret_internal" does not exist' } },
    });
    const body = await registry()
      .handlers.analyze_posts({ post_ids: [ID_A] }, extra())
      .then(json);
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret_internal");
  });
});
