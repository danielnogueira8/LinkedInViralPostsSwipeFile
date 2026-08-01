import { describe, expect, test } from "vitest";
import { createSupabaseTrackedCreatorsRepository } from "@/lib/tracked-creators-supabase";

// Repro of a confirmed bug-hunt finding: list_accounts' `niche` argument flowed
// unescaped into a PostgREST `.or()` filter string (unlike `search`, which
// strips %/_, and unlike the sibling `manual_owner_workspace_id` filter in the
// same file, which correctly calls encodePostgrestValue). A comma in `niche`
// injected an extra top-level OR predicate into the query; a malformed value
// could trip a raw PostgREST parse error. Fixed by wrapping `niche` in
// encodePostgrestValue before interpolation, mirroring the existing pattern.
//
// This test builds a minimal fake Supabase query-builder that satisfies
// applyListFilters' generic constraint ({ is, or }) and records the exact
// `.or()` filter string it's called with, so the escaping is asserted against
// the REAL repository code path (list/listTotal), not a reimplementation.
function fakeQuery(capture: { or: string[] }) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.from = chain;
  q.select = chain;
  q.eq = chain;
  q.order = chain;
  q.limit = chain;
  q.is = chain;
  q.or = (filter: string) => {
    capture.or.push(filter);
    return q;
  };
  // list() awaits the query directly; listTotal() reads {count, error}.
  q.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
    resolve({ data: [], error: null });
  q.count = 0;
  q.error = null;
  return q;
}

function fakeDb(capture: { or: string[] }) {
  return { from: () => fakeQuery(capture) } as unknown as Parameters<
    typeof createSupabaseTrackedCreatorsRepository
  >[0];
}

describe("tracked-creators-supabase — niche filter escaping (bug-hunt fix)", () => {
  test("a comma in niche does NOT inject an extra OR predicate", async () => {
    const capture = { or: [] as string[] };
    const repo = createSupabaseTrackedCreatorsRepository(
      fakeDb(capture),
      "ws-1",
    );
    await repo.list({ niche: "AI,accounts.archived_at.not.is.null" });

    expect(capture.or).toHaveLength(1);
    // The whole niche value is quoted as ONE PostgREST literal — no comma
    // boundary, so it can't be parsed as two separate OR clauses.
    expect(capture.or[0]).toBe(
      `niche.eq."AI,accounts.archived_at.not.is.null",and(niche.is.null,accounts.niche.eq."AI,accounts.archived_at.not.is.null")`,
    );
    expect(capture.or[0]).not.toContain(
      "niche.eq.AI,accounts.archived_at.not.is.null,",
    );
  });

  test("a plain alphanumeric niche is left unquoted (unchanged behavior)", async () => {
    const capture = { or: [] as string[] };
    const repo = createSupabaseTrackedCreatorsRepository(
      fakeDb(capture),
      "ws-1",
    );
    await repo.list({ niche: "SaaS" });

    expect(capture.or[0]).toBe(
      "niche.eq.SaaS,and(niche.is.null,accounts.niche.eq.SaaS)",
    );
  });

  test("search quotes comma-bearing input as one PostgREST value", async () => {
    const capture = { or: [] as string[] };
    const repo = createSupabaseTrackedCreatorsRepository(
      fakeDb(capture),
      "ws-1",
    );
    await repo.list({ search: "Alice,accounts.archived_at.not.is.null" });

    expect(capture.or[0]).toBe(
      'name.ilike."%Alice,accounts.archivedat.not.is.null%",linkedin_handle.ilike."%Alice,accounts.archivedat.not.is.null%"',
    );
  });

  test("listTotal applies the SAME escaping as list (shared filter path)", async () => {
    const capture = { or: [] as string[] };
    const repo = createSupabaseTrackedCreatorsRepository(
      fakeDb(capture),
      "ws-1",
    );
    await repo.listTotal({ niche: "a)OR(1.eq.1" });

    expect(capture.or[0]).toContain('niche.eq."a)OR(1.eq.1"');
  });
});
