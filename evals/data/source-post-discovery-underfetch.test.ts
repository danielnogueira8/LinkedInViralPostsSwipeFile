import { describe, expect, test } from "vitest";
import { discoverSourcePosts } from "@/lib/source-post-discovery";

/**
 * Regression cover for the MCP "only one post" bug.
 *
 * `discoverSourcePosts` applies TWO eligibility layers:
 *   1. SQL-side (is_viral, thresholds, window) — bounded by the DB `limit`
 *   2. JS-side `sourcePostPassesWorkspaceViral` — drops rows this workspace
 *      explicitly declassified
 *
 * The `kind: "limit"` branch (used by MCP get_top_from_batch and the Cowork
 * candidate pool) used to ask the DB for exactly N rows and only then apply
 * layer 2, so every declassified row silently shrank the result. Asking for 5
 * could return 1. The `kind: "page"` branch already backfilled in a loop; the
 * limit branch now does too.
 */

type Row = Record<string, unknown>;

/**
 * Minimal PostgREST double. Records the row count each query asked for so we
 * can assert the fetch actually widened, and replays a fixed table through
 * .limit()/.range() the way supabase-js does.
 */
function fakeDb(table: Row[], requestedLimits: number[]) {
  const builder = () => {
    let offset = 0;
    let take = table.length;
    const chain: Record<string, unknown> = {};
    const passthrough = [
      "select", "eq", "or", "is", "in", "order", "ilike", "textSearch",
      "gte", "lte", "not", "gt", "abortSignal",
    ];
    for (const method of passthrough) chain[method] = () => chain;
    chain.limit = (n: number) => {
      requestedLimits.push(n);
      take = n;
      return chain;
    };
    chain.range = (from: number, to: number) => {
      requestedLimits.push(to - from + 1);
      offset = from;
      take = to - from + 1;
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: table.slice(offset, offset + take), error: null }).then(
        resolve,
      );
    return chain;
  };
  return {
    from: () => builder(),
    // getDiscoveryThresholds reads workspace settings; return none so the
    // defaults apply and the SQL-side threshold filter is a no-op here.
    rpc: undefined,
  } as never;
}

/** A post the workspace has NOT reclassified — always eligible. */
const eligible = (id: string): Row => ({
  id,
  posted_at: "2026-08-02T00:00:00Z",
  reactions: 500,
  post_type: "regular",
  accounts: { name: `author-${id}` },
  workspace_post_classification: [],
});

/** A post this workspace explicitly marked NOT viral — must be dropped. */
const declassified = (id: string): Row => ({
  ...eligible(id),
  workspace_post_classification: [{ is_viral: false }],
});

describe("discoverSourcePosts limit-branch under-fetch", () => {
  test("returns the full requested limit when declassified rows are interleaved", async () => {
    // 4 declassified rows sit ahead of the eligible ones, exactly the shape
    // that produced a single-post MCP answer in production.
    const table = [
      declassified("d1"),
      declassified("d2"),
      eligible("e1"),
      declassified("d3"),
      declassified("d4"),
      eligible("e2"),
      eligible("e3"),
      eligible("e4"),
      eligible("e5"),
    ];
    const requestedLimits: number[] = [];

    const result = await discoverSourcePosts(fakeDb(table, requestedLimits), {
      workspaceId: "user_test",
      columns: "id, posted_at, reactions",
      accountIds: ["acct-1"],
      order: { column: "reactions", ascending: false },
      window: { kind: "limit", limit: 5 },
    });

    // The bug returned 1 (only e1 survived the first 5-row fetch).
    expect(result.rows.map((r) => r.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(result.rows).toHaveLength(5);
  });

  test("never returns more than the requested limit", async () => {
    const table = Array.from({ length: 40 }, (_, i) => eligible(`e${i}`));
    const result = await discoverSourcePosts(fakeDb(table, []), {
      workspaceId: "user_test",
      columns: "id",
      accountIds: ["acct-1"],
      order: { column: "reactions", ascending: false },
      window: { kind: "limit", limit: 5 },
    });
    expect(result.rows).toHaveLength(5);
  });

  test("stops cleanly when the table genuinely has fewer eligible rows", async () => {
    const table = [eligible("e1"), declassified("d1"), eligible("e2")];
    const result = await discoverSourcePosts(fakeDb(table, []), {
      workspaceId: "user_test",
      columns: "id",
      accountIds: ["acct-1"],
      order: { column: "reactions", ascending: false },
      window: { kind: "limit", limit: 10 },
    });
    expect(result.rows.map((r) => r.id)).toEqual(["e1", "e2"]);
  });
});
