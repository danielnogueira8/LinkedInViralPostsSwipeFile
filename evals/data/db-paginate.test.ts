import { describe, test, expect, vi } from "vitest";
import {
  selectAllRows,
  selectInChunks,
  idChunks,
  DB_PAGE,
  DB_IN_CHUNK,
} from "@/lib/db-paginate";

describe("selectAllRows — pages past the PostgREST 1000-row cap", () => {
  test("reads a corpus larger than one page in full", async () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    // Fake builder: .range(from,to) returns exactly that window (mirrors
    // PostgREST); a short final page ends the loop.
    const makeQuery = () => ({
      range: async (from: number, to: number) => ({
        data: all.slice(from, to + 1),
        error: null,
      }),
    });
    const rows = await selectAllRows(makeQuery);
    expect(rows).toHaveLength(2500);
    expect(rows[0].id).toBe(0);
    expect(rows[2499].id).toBe(2499);
  });

  test("a single short page ends immediately", async () => {
    const makeQuery = () => ({
      range: async () => ({ data: [{ id: 1 }, { id: 2 }], error: null }),
    });
    expect(await selectAllRows(makeQuery)).toHaveLength(2);
  });

  test("an exactly-full final page still terminates (no infinite loop)", async () => {
    // 1000 rows then 0 — the boundary case a naive `while (rows.length)` botches.
    const all = Array.from({ length: DB_PAGE }, (_, i) => ({ id: i }));
    const makeQuery = () => ({
      range: async (from: number, to: number) => ({
        data: all.slice(from, to + 1),
        error: null,
      }),
    });
    expect(await selectAllRows(makeQuery)).toHaveLength(DB_PAGE);
  });

  test("throws on a page error", async () => {
    const makeQuery = () => ({
      range: async () => ({ data: null, error: new Error("boom") }),
    });
    await expect(selectAllRows(makeQuery)).rejects.toThrow("boom");
  });
});

describe("selectInChunks — chunks a large .in() to stay under the URL limit", () => {
  test("splits ids into DB_IN_CHUNK-sized queries and concatenates rows", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const seenSliceSizes: number[] = [];
    const rows = await selectInChunks(ids, async (slice) => {
      seenSliceSizes.push(slice.length);
      return { data: slice.map((id) => ({ id })), error: null };
    });
    expect(rows).toHaveLength(450);
    // 450 → 200 + 200 + 50, no slice exceeds the chunk size.
    expect(seenSliceSizes).toEqual([DB_IN_CHUNK, DB_IN_CHUNK, 50]);
    expect(Math.max(...seenSliceSizes)).toBeLessThanOrEqual(DB_IN_CHUNK);
  });

  test("empty ids → no query, empty result", async () => {
    const query = vi.fn();
    expect(await selectInChunks([], query)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test("throws on a chunk error", async () => {
    await expect(
      selectInChunks(["a"], async () => ({ data: null, error: new Error("bad") })),
    ).rejects.toThrow("bad");
  });
});

describe("idChunks", () => {
  test("splits into URL-safe slices", () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(i));
    const chunks = idChunks(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(DB_IN_CHUNK);
    expect(chunks[1]).toHaveLength(50);
    expect(idChunks([])).toEqual([]);
  });
});
