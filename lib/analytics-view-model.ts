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
