// Shared guards for the two PostgREST failure modes this codebase has shipped
// repeatedly:
//   1. Every select silently caps at 1000 rows regardless of `.limit()`, so a
//      full-table read stops at 1000 and looks "done" (the hook-library-stall
//      and backfill-stall bugs).
//   2. `.in("col", [thousands of ids])` builds a query string long enough for
//      PostgREST to reject with 400 "URL too long".
//
// Both are size-dependent: fine in dev, broken once the corpus/roster grows.
// These helpers make the correct pattern a one-liner so new call sites don't
// re-introduce the bug.

export const DB_PAGE = 1000;
// Keep an `.in(...)` id list well under the URL length ceiling. A UUID is ~37
// chars in the query string; 200 ids ≈ 7.4KB, comfortably safe.
export const DB_IN_CHUNK = 200;

// A PostgREST filter builder that resolves to `{ data, error }` when awaited and
// supports `.range()`. We only need those two capabilities here; keeping the
// type minimal avoids fighting supabase-js's deep generics.
type Rangeable<Row> = {
  range: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>;
};

// Read EVERY row of a query, paging past the 1000-row cap with `.range()`.
// `makeQuery(from, to)` must return a fresh, fully-built query for that window
// (a new builder per page — PostgREST builders are single-use). Throws on the
// first page error.
export async function selectAllRows<Row>(
  makeQuery: () => Rangeable<Row>,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += DB_PAGE) {
    const { data, error } = await makeQuery().range(from, from + DB_PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < DB_PAGE) break;
  }
  return out;
}

// Run a `.in(column, ids)` query in URL-safe chunks and concatenate the rows.
// `makeQuery(idSlice)` returns a fresh awaitable query for that slice. Empty
// input → no query, empty result. Throws on the first chunk error.
export async function selectInChunks<Row>(
  ids: readonly string[],
  makeQuery: (idSlice: string[]) => PromiseLike<{ data: Row[] | null; error: unknown }>,
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += DB_IN_CHUNK) {
    const slice = ids.slice(i, i + DB_IN_CHUNK);
    const { data, error } = await makeQuery(slice);
    if (error) throw error;
    out.push(...(data ?? []));
  }
  return out;
}

// Split an id list into URL-safe chunks (for callers that need the slices
// themselves, e.g. to build a paginated `.in()` read per chunk).
export function idChunks(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += DB_IN_CHUNK) {
    chunks.push(ids.slice(i, i + DB_IN_CHUNK));
  }
  return chunks;
}
