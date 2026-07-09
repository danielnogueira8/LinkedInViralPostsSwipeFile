// Source output aggregation for the Content Sources page.
//
// "Output" = is this source actually producing Swipe File material? We show
// posts-saved (from the denormalized accounts.total_post_count) and the best
// post's reaction count. PostgREST has no per-group MAX, so — following the
// same convention as lib/insights-query and lib/pipeline — we fetch the narrow
// (account_id, reactions) rows once, capped, and reduce the max per account in
// JS. No migration, one scoped read.

// Generous cap: a workspace would need this many stored posts across all its
// sources to hit it, at which point a slightly-off "best post" on the tail is
// harmless. Mirrors insights-query's FETCH_CAP intent.
export const SOURCE_POSTS_FETCH_CAP = 20000;

export type PostReactionRow = {
  account_id: string;
  reactions: number | null;
};

// Reduce narrow post rows to the max reactions per account_id. Accounts with no
// posts simply don't appear in the returned map (callers treat missing as null).
export function maxReactionsByAccount(
  rows: PostReactionRow[] | null | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows ?? []) {
    const reactions = r.reactions ?? 0;
    const cur = map.get(r.account_id);
    if (cur === undefined || reactions > cur) map.set(r.account_id, reactions);
  }
  return map;
}
