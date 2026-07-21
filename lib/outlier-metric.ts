// ---------------------------------------------------------------------------
// Outlier metric labels.
//
// "went 1735×" is meaningless to a user. A useful label says WHAT broke out:
// the likes, the comments, or the overall multiple of the creator's norm —
// whichever metric is the strongest outlier for THAT creator (measured against
// their own 90-day median, so a small creator and a big creator are judged on
// the same scale). Used by the agent-loop scanner headlines and the breakout
// radar chip.
// ---------------------------------------------------------------------------

export type MetricBaseline = {
  medianReactions: number | null;
  medianComments: number | null;
};

export function medianOf(values: number[]): number | null {
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Per-account medians from raw metric rows (account_id + reactions + comments).
 * An account needs at least MIN_SAMPLES posts for a median to count — below
 * that the "norm" is noise and the caller falls back to raw counts.
 */
export const BASELINE_MIN_SAMPLES = 5;

export function creatorBaselinesFromRows(
  rows: Array<{
    account_id: string;
    reactions: number | null;
    comments: number | null;
  }>,
): Map<string, MetricBaseline> {
  const byAccount = new Map<string, { reactions: number[]; comments: number[] }>();
  for (const row of rows) {
    const bucket = byAccount.get(row.account_id) ?? {
      reactions: [],
      comments: [],
    };
    if (typeof row.reactions === "number") bucket.reactions.push(row.reactions);
    if (typeof row.comments === "number") bucket.comments.push(row.comments);
    byAccount.set(row.account_id, bucket);
  }
  const baselines = new Map<string, MetricBaseline>();
  for (const [accountId, bucket] of byAccount) {
    baselines.set(accountId, {
      medianReactions:
        bucket.reactions.length >= BASELINE_MIN_SAMPLES
          ? medianOf(bucket.reactions)
          : null,
      medianComments:
        bucket.comments.length >= BASELINE_MIN_SAMPLES
          ? medianOf(bucket.comments)
          : null,
    });
  }
  return baselines;
}

/** 340 → "340", 1_240 → "1.2k", 12_400 → "12.4k". */
export function formatMetricCount(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(Math.round(value));
}

/** The winning metric must beat the creator's norm by at least this much to be
 *  named directly; below it the label falls back to the multiple itself. */
export const OUTLIER_METRIC_RATIO_THRESHOLD = 1.5;

/**
 * Pick the label for an outlier post: the metric that is the STRONGEST outlier
 * for this creator ("2.3k likes" / "140 comments"), or the overall multiple of
 * their norm when neither metric stands out on its own ("1.5× their norm").
 * With no baseline (thin history), the bigger raw metric wins.
 */
export function outlierMetricLabel(
  post: { reactions: number | null; comments: number | null },
  baseline: MetricBaseline | null | undefined,
): string {
  const reactions = post.reactions ?? 0;
  const comments = post.comments ?? 0;
  const ratioReactions = baseline?.medianReactions
    ? reactions / baseline.medianReactions
    : null;
  const ratioComments = baseline?.medianComments
    ? comments / baseline.medianComments
    : null;
  const best = Math.max(ratioReactions ?? 0, ratioComments ?? 0);

  if (best >= OUTLIER_METRIC_RATIO_THRESHOLD) {
    return (ratioReactions ?? 0) >= (ratioComments ?? 0)
      ? `${formatMetricCount(reactions)} likes`
      : `${formatMetricCount(comments)} comments`;
  }
  if (best > 0) {
    return `${best.toFixed(1)}× their norm`;
  }
  return reactions >= comments
    ? `${formatMetricCount(reactions)} likes`
    : `${formatMetricCount(comments)} comments`;
}
