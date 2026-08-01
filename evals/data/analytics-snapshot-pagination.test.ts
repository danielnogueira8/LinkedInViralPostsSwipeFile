import { describe, expect, test } from "vitest";
import { selectAllRows, selectInChunks, DB_PAGE } from "@/lib/db-paginate";

// The analytics page read post_analytics with `.limit(5000)`, which does NOT
// lift PostgREST's 1000-row cap. Rows are ordered snapshot_date ASCENDING, so
// truncation dropped the NEWEST snapshots: the page froze at an old date and
// silently stopped updating. One snapshot per published post per day crosses
// 1000 in roughly ten weeks at 14 posts, so this is reached in normal use.

type Row = { artifact_id: string; snapshot_date: string };

/** A fake table that enforces the 1000-row cap the real server applies. */
function cappedTable(totalRows: number) {
  const all: Row[] = Array.from({ length: totalRows }, (_, i) => ({
    artifact_id: `post-${i % 14}`,
    snapshot_date: `2026-${String(1 + Math.floor(i / 400)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
  return {
    all,
    // What `.limit(n)` actually gets back: never more than the cap.
    limit: (n: number) => all.slice(0, Math.min(n, DB_PAGE)),
    range: (from: number, to: number) =>
      all.slice(from, Math.min(to + 1, from + DB_PAGE)),
  };
}

describe("analytics snapshot reads page past the row cap", () => {
  test("`.limit(5000)` silently returns only the first 1000 rows", () => {
    const table = cappedTable(2600);
    expect(table.limit(5000)).toHaveLength(DB_PAGE);
  });

  test("the dropped rows are the NEWEST ones, so analytics freezes", () => {
    // This is why the bug looked like "analytics stopped updating" rather than
    // "some rows are missing".
    const table = cappedTable(2600);
    const truncated = table.limit(5000);
    const newestSeen = truncated[truncated.length - 1].snapshot_date;
    const newestActual = table.all[table.all.length - 1].snapshot_date;
    expect(newestSeen).not.toBe(newestActual);
  });

  test("selectAllRows returns every snapshot, including the newest", async () => {
    const table = cappedTable(2600);
    const rows = await selectAllRows<Row>(() => ({
      range: async (from, to) => ({ data: table.range(from, to), error: null }),
    }));
    expect(rows).toHaveLength(2600);
    expect(rows[rows.length - 1].snapshot_date).toBe(
      table.all[table.all.length - 1].snapshot_date,
    );
  });

  test("an exact multiple of the page size does not lose the last page", async () => {
    const table = cappedTable(DB_PAGE * 2);
    const rows = await selectAllRows<Row>(() => ({
      range: async (from, to) => ({ data: table.range(from, to), error: null }),
    }));
    expect(rows).toHaveLength(DB_PAGE * 2);
  });

  test("artifact ids are chunked so a long .in() cannot 400", async () => {
    // The title/body join passed every artifact id in one `.in(...)`; past a
    // few hundred ids PostgREST rejects the URL and the page renders empty.
    const ids = Array.from({ length: 900 }, (_, i) => `artifact-${i}`);
    const seen: number[] = [];
    const rows = await selectInChunks<{ id: string }>(ids, async (slice) => {
      seen.push(slice.length);
      return { data: slice.map((id) => ({ id })), error: null };
    });
    expect(rows).toHaveLength(900);
    expect(Math.max(...seen)).toBeLessThanOrEqual(200);
  });
});
