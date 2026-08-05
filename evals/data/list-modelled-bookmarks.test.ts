import { describe, expect, test } from "vitest";
import { listModelledBookmarkResources } from "@/lib/content-resource-operations";

// list_saved_posts returned the ENTIRE bookmark library, so an agent asking
// for modelling sources got every post the team ever saved and had to guess
// which mattered. chat_modeling_sources records what was actually bound to a
// turn, so it is the authoritative "used for modelling" set — no new column,
// no backfill.

type UsedRow = { source_post_id: string | null; created_at: string };
type SavedRow = { id: string; post_url: string };

/** Minimal Supabase double for the two reads this function performs. */
function fakeDb(used: UsedRow[], saved: SavedRow[]) {
  const calls: { table: string; filters: Record<string, unknown> }[] = [];
  return {
    calls,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      calls.push({ table, filters });
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          filters[col] = value;
          return chain;
        },
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        in: (_col: string, ids: string[]) => {
          filters.in = ids;
          return chain;
        },
        then: (
          resolve: (value: { data: unknown[]; error: null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          const data =
            table === "chat_modeling_sources"
              ? used
              : saved.filter((row) =>
                  ((filters.in as string[]) ?? []).includes(row.id),
                );
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      });
      return chain;
    },
  } as never;
}

const bookmark = (id: string): SavedRow => ({
  id,
  post_url: `https://linkedin.com/${id}`,
});

describe("only bookmarks actually modelled are returned", () => {
  test("a saved post never used as a source is excluded", async () => {
    // The reported bug: the library had many posts, only some were modelled.
    const result = await listModelledBookmarkResources({
      db: fakeDb(
        [{ source_post_id: "used-1", created_at: "2026-08-01T10:00:00Z" }],
        [bookmark("used-1"), bookmark("never-used")],
      ),
      workspaceId: "ws-1",
      limit: 20,
    });
    expect(result.map((row) => (row as unknown as SavedRow).id)).toEqual([
      "used-1",
    ]);
  });

  test("a workspace that has modelled nothing returns empty, not everything", async () => {
    // The dangerous failure: an empty source table falling back to "all rows"
    // would silently restore the old behaviour.
    const result = await listModelledBookmarkResources({
      db: fakeDb([], [bookmark("a"), bookmark("b")]),
      workspaceId: "ws-1",
      limit: 20,
    });
    expect(result).toEqual([]);
  });

  test("results are ordered most-recently-modelled first", async () => {
    // `.in()` does not preserve order, so the function restores it explicitly.
    const result = await listModelledBookmarkResources({
      db: fakeDb(
        [
          { source_post_id: "newest", created_at: "2026-08-03T10:00:00Z" },
          { source_post_id: "middle", created_at: "2026-08-02T10:00:00Z" },
          { source_post_id: "oldest", created_at: "2026-08-01T10:00:00Z" },
        ],
        [bookmark("oldest"), bookmark("middle"), bookmark("newest")],
      ),
      workspaceId: "ws-1",
      limit: 20,
    });
    expect(result.map((row) => (row as unknown as SavedRow).id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  test("a bookmark modelled repeatedly appears once, at its latest use", async () => {
    const result = await listModelledBookmarkResources({
      db: fakeDb(
        [
          { source_post_id: "repeat", created_at: "2026-08-03T10:00:00Z" },
          { source_post_id: "other", created_at: "2026-08-02T10:00:00Z" },
          { source_post_id: "repeat", created_at: "2026-08-01T10:00:00Z" },
        ],
        [bookmark("repeat"), bookmark("other")],
      ),
      workspaceId: "ws-1",
      limit: 20,
    });
    expect(result.map((row) => (row as unknown as SavedRow).id)).toEqual([
      "repeat",
      "other",
    ]);
  });

  test("a bookmark deleted since it was modelled drops out silently", async () => {
    const result = await listModelledBookmarkResources({
      db: fakeDb(
        [
          { source_post_id: "deleted", created_at: "2026-08-03T10:00:00Z" },
          { source_post_id: "kept", created_at: "2026-08-02T10:00:00Z" },
        ],
        [bookmark("kept")],
      ),
      workspaceId: "ws-1",
      limit: 20,
    });
    expect(result.map((row) => (row as unknown as SavedRow).id)).toEqual([
      "kept",
    ]);
  });

  test("both reads are workspace-scoped", async () => {
    // Tenancy (ADR-0001): a service-role read must carry the predicate
    // explicitly on EVERY table it touches, not just the first.
    const db = fakeDb(
      [{ source_post_id: "used-1", created_at: "2026-08-01T10:00:00Z" }],
      [bookmark("used-1")],
    );
    await listModelledBookmarkResources({ db, workspaceId: "ws-1", limit: 20 });
    const calls = (db as unknown as { calls: { table: string; filters: Record<string, unknown> }[] }).calls;
    expect(calls.map((call) => call.table).sort()).toEqual([
      "chat_modeling_sources",
      "saved_posts",
    ]);
    for (const call of calls) {
      expect(call.filters.workspace_id).toBe("ws-1");
    }
  });

  test("only bookmark-sourced rows count, not swipe-file ones", async () => {
    const db = fakeDb(
      [{ source_post_id: "used-1", created_at: "2026-08-01T10:00:00Z" }],
      [bookmark("used-1")],
    );
    await listModelledBookmarkResources({ db, workspaceId: "ws-1", limit: 20 });
    const sourcesCall = (
      db as unknown as { calls: { table: string; filters: Record<string, unknown> }[] }
    ).calls.find((call) => call.table === "chat_modeling_sources");
    expect(sourcesCall?.filters.source).toBe("bookmark");
  });
});
