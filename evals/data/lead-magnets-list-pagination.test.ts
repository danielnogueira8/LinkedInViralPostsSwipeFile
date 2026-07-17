import { describe, expect, test, vi, beforeEach } from "vitest";

// GET /api/lead-magnets used a bare .select() with no .range()/pagination,
// so a workspace with more than PostgREST's silent 1000-row cap would lose
// lead magnets past row 1000. Unlike creator styles (capped at 10) and
// content templates (capped at 100), lead magnets have no total-count cap —
// only a 10/month AI-generation limit, with manual/URL-imported ones
// unbounded — so this is the one reachable case of the three. Fixed via
// selectAllRows (lib/db-paginate.ts), which pages past the cap with .range().

const DB_PAGE = 1000;
let allRows: Array<{
  id: string;
  workspace_id: string;
  updated_at: string;
  markdown_body: string;
  metadata: Record<string, unknown>;
}> = [];
const rangeCalls: Array<[number, number]> = [];

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user-1" }),
}));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws-1",
    raw: {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = (_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            // The AI-usage count query — unrelated to the list pagination.
            return { ...chain, then: (r: (v: unknown) => unknown) => r({ count: 0, error: null }) };
          }
          return chain;
        };
        chain.eq = () => chain;
        chain.gte = () => chain;
        chain.order = () => chain;
        chain.range = (from: number, to: number) => {
          rangeCalls.push([from, to]);
          const slice = allRows.slice(from, to + 1);
          return Promise.resolve({ data: slice, error: null });
        };
        return chain;
      },
    },
  }),
}));

const { GET } = await import("@/app/api/lead-magnets/route");

beforeEach(() => {
  allRows = [];
  rangeCalls.length = 0;
});

describe("GET /api/lead-magnets pagination", () => {
  test("a single page under 1000 rows makes exactly one .range() call", async () => {
    allRows = Array.from({ length: 5 }, (_, i) => ({
      id: `lm-${i}`,
      workspace_id: "ws-1",
      updated_at: "2026-01-01T00:00:00.000Z",
      markdown_body: "body",
      metadata: {},
    }));
    const res = await GET();
    const body = await res.json();
    expect(body.leadMagnets).toHaveLength(5);
    expect(rangeCalls).toEqual([[0, DB_PAGE - 1]]);
  });

  test("more than 1000 rows pages past PostgREST's silent cap instead of truncating", async () => {
    allRows = Array.from({ length: DB_PAGE + 250 }, (_, i) => ({
      id: `lm-${i}`,
      workspace_id: "ws-1",
      updated_at: "2026-01-01T00:00:00.000Z",
      markdown_body: "body",
      metadata: {},
    }));
    const res = await GET();
    const body = await res.json();
    expect(body.leadMagnets).toHaveLength(DB_PAGE + 250);
    expect(rangeCalls).toEqual([
      [0, DB_PAGE - 1],
      [DB_PAGE, 2 * DB_PAGE - 1],
    ]);
  });
});
