import { describe, expect, test } from "vitest";
import { selectAllRows, selectInChunks, DB_PAGE } from "@/lib/db-paginate";

// listEligibleWorkspaces reads five CROSS-WORKSPACE tables to decide which
// workspaces get inbox cards. They grow with total users, not with one
// workspace's data, and `.limit(5000)` does not lift PostgREST's 1000-row cap.
// Past 1000 rows the extra workspaces silently disappeared from the
// eligibility list and stopped receiving cards — no error, because a short
// response looks exactly like "that is all there is".

function cappedRows(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({
    workspace_id: `ws-${String(i).padStart(5, "0")}`,
  }));
  return {
    all,
    limit: (n: number) => all.slice(0, Math.min(n, DB_PAGE)),
    range: (from: number, to: number) =>
      all.slice(from, Math.min(to + 1, from + DB_PAGE)),
  };
}

describe("agent inbox eligibility is not truncated at 1000 workspaces", () => {
  test("`.limit(5000)` drops every workspace past the cap", () => {
    const table = cappedRows(1500);
    const seen = table.limit(5000);
    expect(seen).toHaveLength(DB_PAGE);
    // 500 workspaces would never receive a card, silently.
    expect(table.all.length - seen.length).toBe(500);
  });

  test("paging recovers every eligible workspace", async () => {
    const table = cappedRows(1500);
    const rows = await selectAllRows<{ workspace_id: string }>(() => ({
      range: async (from, to) => ({ data: table.range(from, to), error: null }),
    }));
    expect(rows).toHaveLength(1500);
    expect(rows[rows.length - 1].workspace_id).toBe(
      table.all[table.all.length - 1].workspace_id,
    );
  });

  test("a workspace just past the cap is still eligible", async () => {
    // The specific regression: ws-01000 is the first one the old read lost.
    const table = cappedRows(1001);
    const rows = await selectAllRows<{ workspace_id: string }>(() => ({
      range: async (from, to) => ({ data: table.range(from, to), error: null }),
    }));
    expect(rows.map((r) => r.workspace_id)).toContain("ws-01000");
    expect(table.limit(5000).map((r) => r.workspace_id)).not.toContain(
      "ws-01000",
    );
  });

  test("creator baselines chunk account ids and page each chunk", async () => {
    // scan.ts had BOTH failures: a capped read and an unchunked `.in(...)`.
    // A truncated 90-day baseline reads low, so ordinary posts look viral.
    const accountIds = Array.from({ length: 640 }, (_, i) => `acct-${i}`);
    const chunkSizes: number[] = [];
    const rows = await selectInChunks<{ account_id: string }>(
      accountIds,
      async (ids) => {
        chunkSizes.push(ids.length);
        return { data: ids.map((account_id) => ({ account_id })), error: null };
      },
    );
    expect(rows).toHaveLength(640);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(200);
  });
});
