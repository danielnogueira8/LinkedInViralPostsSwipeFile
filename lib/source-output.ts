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

// "Last checked" copy from an ISO timestamp (accounts.synced_at). Kept
// deliberately coarse — sources are checked on the scheduled scrape cadence, so
// day-level granularity is all that's meaningful. `now` is injectable for tests.
export function formatLastChecked(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "Not checked yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not checked yet";
  // Compare on calendar-day boundaries so "yesterday at 11pm" reads as Yesterday
  // rather than "Today" just because it's within 24h.
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return "Last checked: Today";
  if (diffDays === 1) return "Last checked: Yesterday";
  if (diffDays < 7) return `Last checked: ${diffDays} days ago`;
  return `Last checked: ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
