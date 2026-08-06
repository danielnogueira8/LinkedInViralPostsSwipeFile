// ---------------------------------------------------------------------------
// Post performance: what actually happened to the posts this workspace
// published.
//
// post_analytics stores ONE CUMULATIVE SNAPSHOT PER (artifact, day). "How did
// this post do" is therefore the LATEST snapshot for that artifact, not a sum
// over its rows — summing would multiply a post's numbers by however many days
// it has been tracked. That mistake is silent (bigger numbers still look like
// numbers), so the fold lives here as one tested function instead of being
// re-derived per caller.
//
// Everything in this module is pure. The DB read and the MCP envelope live at
// the call site; this file is the part worth unit-testing, and it carries no
// LLM call — performance is measured, never inferred.
// ---------------------------------------------------------------------------

/** One raw snapshot row as stored (cumulative counters as of `snapshotDate`). */
export type PerformanceSnapshot = {
  artifactId: string;
  snapshotDate: string; // YYYY-MM-DD
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  sends: number | null;
};

/** The post itself, joined in for context the metrics alone don't carry. */
export type PerformanceArtifact = {
  artifactId: string;
  title: string | null;
  body: string | null;
  publishedAt: string | null;
  kind: string | null;
};

export type PerformanceRow = {
  artifact_id: string;
  title: string;
  excerpt: string;
  post_type: "regular" | "lead_magnet";
  published_at: string | null;
  measured_on: string;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  sends: number | null;
  engagements: number;
  engagement_rate: number | null;
};

export type PerformanceSortKey =
  | "impressions"
  | "engagements"
  | "engagement_rate"
  | "likes"
  | "comments"
  | "published";

const EXCERPT_CHARS = 280;

/**
 * Reduce every snapshot to the newest one per artifact.
 *
 * Callers must NOT assume input ordering. The analytics page relies on rows
 * arriving date-ascending so a later write wins; that coupling breaks silently
 * the moment a query's `.order()` changes, and the failure mode (stale numbers
 * that still look plausible) is invisible. Comparing dates explicitly makes the
 * result order-independent.
 */
export function latestSnapshotPerArtifact(
  snapshots: readonly PerformanceSnapshot[],
): Map<string, PerformanceSnapshot> {
  const latest = new Map<string, PerformanceSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.artifactId);
    if (!current || snapshot.snapshotDate > current.snapshotDate) {
      latest.set(snapshot.artifactId, snapshot);
    }
  }
  return latest;
}

/**
 * Total interactions. Impressions are reach, not engagement, so they are
 * excluded — mixing them in would make every post look like it performed in
 * proportion to how many people simply scrolled past it.
 */
export function engagementsOf(snapshot: PerformanceSnapshot): number {
  return (
    (snapshot.likes ?? 0) +
    (snapshot.comments ?? 0) +
    (snapshot.shares ?? 0) +
    (snapshot.saves ?? 0) +
    (snapshot.sends ?? 0)
  );
}

/**
 * Engagements per impression.
 *
 * Null — not 0 — when impressions are missing or zero. A post whose impressions
 * haven't landed yet has an UNKNOWN rate, and reporting that as 0 would rank it
 * as the worst-performing post the workspace ever published.
 */
export function engagementRateOf(snapshot: PerformanceSnapshot): number | null {
  const impressions = snapshot.impressions;
  if (impressions == null || impressions <= 0) return null;
  return engagementsOf(snapshot) / impressions;
}

function excerptOf(body: string | null): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  return text.length <= EXCERPT_CHARS
    ? text
    : `${text.slice(0, EXCERPT_CHARS).trimEnd()}…`;
}

function titleOf(artifact: PerformanceArtifact): string {
  const explicit = artifact.title?.trim();
  if (explicit) return explicit;
  const firstLine = (artifact.body ?? "").split("\n")[0]?.trim() ?? "";
  return firstLine.slice(0, 80) || "Untitled post";
}

/**
 * Join artifacts to their latest snapshot.
 *
 * An artifact with no snapshot is dropped: it was published but never measured
 * (too new for the daily cron, or Zernio has not reported it). Emitting it with
 * null metrics would put rows in the response that answer "what performed well"
 * with "unknown", which is worse than a shorter, honest list.
 */
export function buildPerformanceRows(
  artifacts: readonly PerformanceArtifact[],
  snapshots: readonly PerformanceSnapshot[],
): PerformanceRow[] {
  const latest = latestSnapshotPerArtifact(snapshots);
  const rows: PerformanceRow[] = [];
  for (const artifact of artifacts) {
    const snapshot = latest.get(artifact.artifactId);
    if (!snapshot) continue;
    rows.push({
      artifact_id: artifact.artifactId,
      title: titleOf(artifact),
      excerpt: excerptOf(artifact.body),
      post_type: artifact.kind === "lead_magnet" ? "lead_magnet" : "regular",
      published_at: artifact.publishedAt,
      measured_on: snapshot.snapshotDate,
      impressions: snapshot.impressions,
      reach: snapshot.reach,
      likes: snapshot.likes,
      comments: snapshot.comments,
      shares: snapshot.shares,
      saves: snapshot.saves,
      sends: snapshot.sends,
      engagements: engagementsOf(snapshot),
      engagement_rate: engagementRateOf(snapshot),
    });
  }
  return rows;
}

function sortValue(row: PerformanceRow, key: PerformanceSortKey): number | null {
  switch (key) {
    case "impressions":
      return row.impressions;
    case "engagements":
      return row.engagements;
    case "engagement_rate":
      return row.engagement_rate;
    case "likes":
      return row.likes;
    case "comments":
      return row.comments;
    case "published":
      return row.published_at ? Date.parse(row.published_at) : null;
  }
}

/**
 * Rank rows, always sinking unknowns.
 *
 * Nulls go last in BOTH directions. Ascending by engagement_rate is the "what
 * underperformed" question, and answering it with posts whose rate is merely
 * unmeasured would point the caller at the wrong posts entirely.
 */
export function sortPerformanceRows(
  rows: readonly PerformanceRow[],
  key: PerformanceSortKey,
  direction: "asc" | "desc" = "desc",
): PerformanceRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    if (left === right) {
      // Stable, meaningful tiebreak: newest first regardless of direction, so
      // equal-scoring posts don't come back in arbitrary DB order.
      const at = a.published_at ? Date.parse(a.published_at) : 0;
      const bt = b.published_at ? Date.parse(b.published_at) : 0;
      return bt - at;
    }
    return (left - right) * sign;
  });
}

export type PerformanceTotals = {
  posts: number;
  impressions: number;
  engagements: number;
  /** Aggregate rate over posts that HAVE impressions (see below). */
  engagement_rate: number | null;
  measured_posts: number;
};

/**
 * Workspace totals.
 *
 * The aggregate rate is total engagements / total impressions across posts with
 * known impressions — NOT the mean of per-post rates, which would let one post
 * with 12 impressions and a freak 50% rate outweigh a post with 40,000. Posts
 * lacking impressions are excluded from both sides of that ratio so the
 * denominator and numerator describe the same set; `measured_posts` reports how
 * many that was, so a caller can see the totals do not cover everything.
 */
export function performanceTotals(
  rows: readonly PerformanceRow[],
): PerformanceTotals {
  let impressions = 0;
  let engagements = 0;
  let measured = 0;
  for (const row of rows) {
    if (row.impressions != null && row.impressions > 0) {
      impressions += row.impressions;
      engagements += row.engagements;
      measured += 1;
    }
  }
  return {
    posts: rows.length,
    impressions,
    engagements,
    engagement_rate: impressions > 0 ? engagements / impressions : null,
    measured_posts: measured,
  };
}
