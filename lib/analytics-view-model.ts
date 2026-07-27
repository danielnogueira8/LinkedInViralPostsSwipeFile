// Server-safe analytics view-model: the row/point shapes and the pure helpers
// that shape analytics data. This module has NO "use client" directive and no
// React/browser imports, so the server component (analytics/page.tsx) can call
// these at request time — a "use client" module's functions cannot be invoked
// from the server (Next.js throws "Attempted to call X from the server but X is
// on the client"). The client view re-exports these for its own use.

export type PostMetricsRow = {
  artifactId: string;
  title: string;
  publishedAt: string | null;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  sends: number | null;
};

export type TrendPoint = { date: string; impressions: number };

export type AnalyticsSnapshot = {
  artifactId: string;
  snapshotDate: string;
  impressions: number | null;
};

export type AnalyticsSummary = {
  impressions: number;
  engagements: number;
  engagementRate: number | null;
  posts: number;
};

// LinkedIn analytics snapshots are cumulative. A trend must therefore add
// the change from each post's previous observation, not add the cumulative
// values captured on a date. The first observation establishes a baseline.
// Provider corrections can lower a total; retain the prior high-water mark so
// a later restoration is not counted again as new user activity.
export function buildDailyImpressionGains(
  snapshots: readonly AnalyticsSnapshot[],
): TrendPoint[] {
  const ordered = [...snapshots].sort((a, b) => {
    if (a.artifactId !== b.artifactId) {
      return a.artifactId.localeCompare(b.artifactId);
    }
    return a.snapshotDate.localeCompare(b.snapshotDate);
  });
  const highWaterByArtifact = new Map<string, number>();
  const byDay = new Map<string, number>();

  for (const snapshot of ordered) {
    if (snapshot.impressions === null) continue;
    const highWater = highWaterByArtifact.get(snapshot.artifactId);
    if (highWater === undefined) {
      highWaterByArtifact.set(snapshot.artifactId, snapshot.impressions);
      continue;
    }
    const gain = Math.max(0, snapshot.impressions - highWater);
    highWaterByArtifact.set(
      snapshot.artifactId,
      Math.max(highWater, snapshot.impressions),
    );
    byDay.set(snapshot.snapshotDate, (byDay.get(snapshot.snapshotDate) ?? 0) + gain);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, impressions]) => ({ date, impressions }));
}

// "Engagements" is deliberately explicit and stable: every interaction
// LinkedIn reports for these posts, excluding passive impressions/reach.
export function summarizePostMetrics(
  posts: readonly PostMetricsRow[],
): AnalyticsSummary {
  const value = (metric: number | null) => metric ?? 0;
  const impressions = posts.reduce(
    (total, post) => total + value(post.impressions),
    0,
  );
  const engagements = posts.reduce(
    (total, post) =>
      total +
      value(post.likes) +
      value(post.comments) +
      value(post.shares) +
      value(post.saves) +
      value(post.sends),
    0,
  );
  return {
    impressions,
    engagements,
    engagementRate:
      impressions > 0
        ? Math.round((engagements / impressions) * 1000) / 10
        : null,
    posts: posts.length,
  };
}

// Round a value UP to a "nice" number (1/2/5 × 10ⁿ) so the chart's top
// gridline is a clean round figure (7 → 10, 4200 → 5000, 13000 → 20000).
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude; // 1 ≤ normalized < 10
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

// The Y-axis scale for the impressions chart: a nice rounded top plus evenly
// spaced tick values from top down to 0 (so the axis reads top-to-bottom).
// Pure + exported so the tick math is unit-tested.
export function impressionAxisTicks(
  maxValue: number,
  divisions = 2,
): { top: number; ticks: number[] } {
  const top = niceCeil(Math.max(1, maxValue));
  const ticks: number[] = [];
  for (let i = divisions; i >= 0; i--) ticks.push((top / divisions) * i);
  return { top, ticks };
}

// Order the analytics table with the most recent posts on top: publish date
// descending, undated posts last, ties broken by impressions (desc) so the
// order is deterministic. Sorts a copy; pure + exported for unit tests.
export function sortPostsByRecency(posts: PostMetricsRow[]): PostMetricsRow[] {
  return [...posts].sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : NaN;
    const aValid = !Number.isNaN(at);
    const bValid = !Number.isNaN(bt);
    if (aValid && bValid && at !== bt) return bt - at;
    if (aValid !== bValid) return aValid ? -1 : 1; // dated before undated
    return (b.impressions ?? 0) - (a.impressions ?? 0);
  });
}
