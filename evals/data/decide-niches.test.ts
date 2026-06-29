import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// workspaceNiches — feeds the decision call the workspace's REAL tracked niches
// so it can't invent options the workspace doesn't have (the "asked about a
// niche we don't track" bug). Mocks the DB; never throws → [] on any failure.
// ---------------------------------------------------------------------------

const accountIdsRef: { current: string[] } = { current: ["acc-1", "acc-2"] };
const nicheRowsRef: {
  current: { data: unknown; error: unknown };
} = { current: { data: [], error: null } };

vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => accountIdsRef.current,
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          is: async () => nicheRowsRef.current,
        }),
      }),
    }),
  }),
}));

const { workspaceNiches } = await import("@/lib/agent/decide");

beforeEach(() => {
  accountIdsRef.current = ["acc-1", "acc-2"];
  nicheRowsRef.current = { data: [], error: null };
});

describe("workspaceNiches", () => {
  test("returns distinct niches ordered by frequency", async () => {
    nicheRowsRef.current = {
      data: [
        { niche: "AI", accounts: { niche: "AI", archived_at: null } },
        { niche: "SaaS", accounts: { niche: "SaaS", archived_at: null } },
        { niche: "AI", accounts: { niche: "AI", archived_at: null } },
      ],
      error: null,
    };
    const out = await workspaceNiches("ws");
    expect(out[0]).toBe("AI"); // most frequent first
    expect(out).toContain("SaaS");
    expect(new Set(out).size).toBe(out.length); // distinct
  });

  test("falls back to the joined account niche when the row niche is null", async () => {
    nicheRowsRef.current = {
      data: [{ niche: null, accounts: { niche: "Fintech", archived_at: null } }],
      error: null,
    };
    expect(await workspaceNiches("ws")).toEqual(["Fintech"]);
  });

  test("empty workspace (no tracked accounts) → []", async () => {
    accountIdsRef.current = [];
    expect(await workspaceNiches("ws")).toEqual([]);
  });

  test("a DB error → [] (never throws — fail-open contract)", async () => {
    nicheRowsRef.current = { data: null, error: { message: "boom" } };
    expect(await workspaceNiches("ws")).toEqual([]);
  });

  test("no workspaceId → [] without touching the DB", async () => {
    expect(await workspaceNiches("")).toEqual([]);
  });

  test("blank niche strings are dropped", async () => {
    nicheRowsRef.current = {
      data: [
        { niche: "  ", accounts: { niche: "  ", archived_at: null } },
        { niche: "AI", accounts: { niche: "AI", archived_at: null } },
      ],
      error: null,
    };
    expect(await workspaceNiches("ws")).toEqual(["AI"]);
  });
});
