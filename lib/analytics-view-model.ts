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
  contentType: PostContentType;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  sends: number | null;
};

export type TrendPoint = { date: string; impressions: number };
export type AnalyticsTrendPoint = {
  date: string;
  impressions: number | null;
  engagements: number | null;
  engagementRate: number | null;
  comments: number | null;
  savesAndShares: number | null;
};

export type AnalyticsSnapshot = {
  artifactId: string;
  snapshotDate: string;
  impressions: number | null;
  reach?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  sends?: number | null;
};

export type AnalyticsSummary = {
  impressions: number;
  engagements: number;
  engagementRate: number | null;
  posts: number;
};

export const ANALYTICS_PERIOD_OPTIONS = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "all", label: "All" },
] as const;
export type AnalyticsPeriod =
  (typeof ANALYTICS_PERIOD_OPTIONS)[number]["value"];
export type PostContentType = "regular" | "lead_magnet";
export const ANALYTICS_CONTENT_TYPE_OPTIONS = [
  { value: "all", label: "All posts" },
  { value: "regular", label: "Regular" },
  { value: "lead_magnet", label: "Lead magnets" },
] as const;
export type AnalyticsContentType =
  (typeof ANALYTICS_CONTENT_TYPE_OPTIONS)[number]["value"];
export type AnalyticsFilters = {
  period: AnalyticsPeriod;
  contentType: AnalyticsContentType;
};
export type DateWindow = { start: string | null; end: string };
export type AnalyticsPeriodBounds = {
  current: DateWindow;
  previous: DateWindow | null;
};
export type AnalyticsChangeInsight = {
  headline: string;
  detail: string;
  direction: "up" | "down" | "neutral";
};

export const ANALYTICS_TREND_METRIC_OPTIONS = [
  { value: "impressions", label: "Impressions" },
  { value: "engagements", label: "Engagements" },
  { value: "engagementRate", label: "Engagement rate" },
  { value: "comments", label: "Comments" },
  { value: "savesAndShares", label: "Saves + shares" },
] as const;
export type AnalyticsTrendMetric =
  (typeof ANALYTICS_TREND_METRIC_OPTIONS)[number]["value"];

export const POST_PERFORMANCE_SORT_OPTIONS = [
  { value: "recent", label: "Most recent" },
  { value: "impressions", label: "Impressions" },
  { value: "engagementRate", label: "Engagement rate" },
  { value: "comments", label: "Comments" },
  { value: "savesAndShares", label: "Saves + shares" },
] as const;
export type PostPerformanceSort =
  (typeof POST_PERFORMANCE_SORT_OPTIONS)[number]["value"];

export function parseAnalyticsFilters(
  query: Record<string, string | string[] | undefined>,
): AnalyticsFilters {
  const period = query.period;
  const contentType = query.type;
  return {
    period:
      typeof period === "string" &&
      ANALYTICS_PERIOD_OPTIONS.some((option) => option.value === period)
        ? (period as AnalyticsPeriod)
        : "30d",
    contentType:
      typeof contentType === "string" &&
      ANALYTICS_CONTENT_TYPE_OPTIONS.some(
        (option) => option.value === contentType,
      )
        ? (contentType as AnalyticsContentType)
        : "all",
  };
}

function shiftIsoDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function periodBounds(
  period: AnalyticsPeriod,
  today: string,
): AnalyticsPeriodBounds {
  if (period === "all") {
    return { current: { start: null, end: today }, previous: null };
  }
  const days = Number.parseInt(period, 10);
  const currentStart = shiftIsoDate(today, -(days - 1));
  return {
    current: { start: currentStart, end: today },
    previous: {
      start: shiftIsoDate(currentStart, -days),
      end: shiftIsoDate(currentStart, -1),
    },
  };
}

type SnapshotMetric =
  | "impressions"
  | "reach"
  | "likes"
  | "comments"
  | "shares"
  | "saves"
  | "sends";

const ENGAGEMENT_METRIC_DEFINITIONS = [
  { key: "likes", label: "reactions" },
  { key: "comments", label: "comments" },
  { key: "shares", label: "shares" },
  { key: "saves", label: "saves" },
  { key: "sends", label: "sends" },
] as const satisfies readonly { key: SnapshotMetric; label: string }[];
type EngagementMetric = (typeof ENGAGEMENT_METRIC_DEFINITIONS)[number]["key"];
const ENGAGEMENT_METRICS: readonly EngagementMetric[] =
  ENGAGEMENT_METRIC_DEFINITIONS.map(({ key }) => key);
const engagementLabels = ENGAGEMENT_METRIC_DEFINITIONS.map(
  ({ label }) => label,
);
export const ENGAGEMENT_RATE_HELP = `Percentage of impressions that resulted in an interaction. Includes ${engagementLabels
  .slice(0, -1)
  .join(", ")}, and ${engagementLabels.at(-1)} when LinkedIn provides them.`;

type MetricGain = { artifactId: string; date: string; gain: number };

function buildMetricGains(
  snapshots: readonly AnalyticsSnapshot[],
  metric: SnapshotMetric,
): MetricGain[] {
  const ordered = [...snapshots].sort((a, b) => {
    if (a.artifactId !== b.artifactId) {
      return a.artifactId.localeCompare(b.artifactId);
    }
    return a.snapshotDate.localeCompare(b.snapshotDate);
  });
  const highWaterByArtifact = new Map<string, number>();
  const gains: MetricGain[] = [];

  for (const snapshot of ordered) {
    const current = snapshot[metric];
    if (current === null || current === undefined) continue;
    const highWater = highWaterByArtifact.get(snapshot.artifactId);
    if (highWater === undefined) {
      highWaterByArtifact.set(snapshot.artifactId, current);
      continue;
    }
    const gain = Math.max(0, current - highWater);
    highWaterByArtifact.set(snapshot.artifactId, Math.max(highWater, current));
    gains.push({
      artifactId: snapshot.artifactId,
      date: snapshot.snapshotDate,
      gain,
    });
  }
  return gains;
}

function buildDailyMetricGains(
  snapshots: readonly AnalyticsSnapshot[],
  metric: SnapshotMetric,
): Map<string, number> {
  return sumMetricGainsByDay(buildMetricGains(snapshots, metric));
}

function sumMetricGainsByDay(gains: readonly MetricGain[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const entry of gains) {
    byDay.set(entry.date, (byDay.get(entry.date) ?? 0) + entry.gain);
  }
  return byDay;
}

function buildAvailableDailyEngagementRates(
  impressionGains: readonly MetricGain[],
  interactionGains: Readonly<Record<EngagementMetric, MetricGain[]>>,
): Map<string, number> {
  type Observation = {
    date: string;
    impressions?: number;
    interactions: Partial<Record<EngagementMetric, number>>;
  };
  const observations = new Map<string, Observation>();
  const observationFor = (gain: MetricGain): Observation => {
    const key = `${gain.artifactId}\u0000${gain.date}`;
    const observation = observations.get(key) ?? {
      date: gain.date,
      interactions: {},
    };
    observations.set(key, observation);
    return observation;
  };

  for (const gain of impressionGains) {
    observationFor(gain).impressions = gain.gain;
  }
  for (const metric of ENGAGEMENT_METRICS) {
    for (const gain of interactionGains[metric]) {
      observationFor(gain).interactions[metric] = gain.gain;
    }
  }

  const eligibleByDate = new Map<
    string,
    { impressions: number; engagements: number }
  >();
  for (const observation of observations.values()) {
    const availableInteractions = ENGAGEMENT_METRICS.filter((metric) =>
      Object.prototype.hasOwnProperty.call(observation.interactions, metric),
    );
    if (
      observation.impressions === undefined ||
      availableInteractions.length === 0
    ) {
      continue;
    }
    const daily = eligibleByDate.get(observation.date) ?? {
      impressions: 0,
      engagements: 0,
    };
    daily.impressions += observation.impressions;
    daily.engagements += availableInteractions.reduce(
      (total, metric) => total + (observation.interactions[metric] ?? 0),
      0,
    );
    eligibleByDate.set(observation.date, daily);
  }

  return new Map(
    [...eligibleByDate.entries()]
      .filter(([, daily]) => daily.impressions > 0)
      .map(([date, daily]) => [
        date,
        Math.round((daily.engagements / daily.impressions) * 1000) / 10,
      ]),
  );
}

// LinkedIn analytics snapshots are cumulative. A trend must therefore add
// the change from each post's previous observation, not add the cumulative
// values captured on a date. The first observation establishes a baseline.
// Provider corrections can lower a total; retain the prior high-water mark so
// a later restoration is not counted again as new user activity.
export function buildDailyImpressionGains(
  snapshots: readonly AnalyticsSnapshot[],
): TrendPoint[] {
  return [...buildDailyMetricGains(snapshots, "impressions").entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, impressions]) => ({ date, impressions }));
}

export function buildAnalyticsTrend(
  snapshots: readonly AnalyticsSnapshot[],
): AnalyticsTrendPoint[] {
  const impressionGains = buildMetricGains(snapshots, "impressions");
  const interactionGains = Object.fromEntries(
    ENGAGEMENT_METRICS.map((metric) => [
      metric,
      buildMetricGains(snapshots, metric),
    ]),
  ) as Record<EngagementMetric, MetricGain[]>;
  const impressions = sumMetricGainsByDay(impressionGains);
  const interactions = Object.fromEntries(
    ENGAGEMENT_METRICS.map((metric) => [
      metric,
      sumMetricGainsByDay(interactionGains[metric]),
    ]),
  ) as Record<EngagementMetric, Map<string, number>>;
  const engagementRates = buildAvailableDailyEngagementRates(
    impressionGains,
    interactionGains,
  );
  const dates = new Set([
    ...impressions.keys(),
    ...ENGAGEMENT_METRICS.flatMap((metric) => [
      ...interactions[metric].keys(),
    ]),
  ]);

  return [...dates]
    .sort((a, b) => a.localeCompare(b))
    .map((date) => {
      const dailyImpressions = impressions.get(date) ?? null;
      const dailyComments = interactions.comments.get(date) ?? null;
      const dailyShares = interactions.shares.get(date) ?? null;
      const dailySaves = interactions.saves.get(date) ?? null;
      const interactionValues = ENGAGEMENT_METRICS.map((metric) =>
        interactions[metric].get(date),
      ).filter((value): value is number => value !== undefined);
      const engagements =
        interactionValues.length > 0
          ? interactionValues.reduce((total, value) => total + value, 0)
          : null;
      return {
        date,
        impressions: dailyImpressions,
        engagements,
        engagementRate: engagementRates.get(date) ?? null,
        comments: dailyComments,
        savesAndShares:
          dailySaves === null && dailyShares === null
            ? null
            : (dailySaves ?? 0) + (dailyShares ?? 0),
      };
    });
}

export function filterAnalyticsContent(
  posts: readonly PostMetricsRow[],
  snapshots: readonly AnalyticsSnapshot[],
  contentType: AnalyticsContentType,
): { posts: PostMetricsRow[]; snapshots: AnalyticsSnapshot[] } {
  if (contentType === "all") {
    return { posts: [...posts], snapshots: [...snapshots] };
  }
  const filteredPosts = posts.filter((post) => post.contentType === contentType);
  const artifactIds = new Set(filteredPosts.map((post) => post.artifactId));
  return {
    posts: filteredPosts,
    snapshots: snapshots.filter((snapshot) =>
      artifactIds.has(snapshot.artifactId),
    ),
  };
}

function isInWindow(date: string, window: DateWindow): boolean {
  return (
    (window.start === null || date >= window.start) && date <= window.end
  );
}

export function buildAnalyticsPeriod(
  snapshots: readonly AnalyticsSnapshot[],
  posts: readonly PostMetricsRow[],
  window: DateWindow,
): AnalyticsSummary {
  return summarizePostMetrics(buildPeriodPostMetrics(snapshots, posts, window));
}

function buildPeriodPostMetrics(
  snapshots: readonly AnalyticsSnapshot[],
  posts: readonly PostMetricsRow[],
  window: DateWindow,
): PostMetricsRow[] {
  if (window.start === null) return [...posts];

  const metrics: SnapshotMetric[] = [
    "impressions",
    "reach",
    "likes",
    "comments",
    "shares",
    "saves",
    "sends",
  ];
  const totalsByMetric = new Map<
    SnapshotMetric,
    Map<string, number>
  >();
  for (const metric of metrics) {
    const byArtifact = new Map<string, number>();
    for (const entry of buildMetricGains(snapshots, metric)) {
      if (!isInWindow(entry.date, window)) continue;
      byArtifact.set(
        entry.artifactId,
        (byArtifact.get(entry.artifactId) ?? 0) + entry.gain,
      );
    }
    totalsByMetric.set(metric, byArtifact);
  }

  return posts
    .map((post) => {
      const metric = (name: SnapshotMetric) => {
        const values = totalsByMetric.get(name);
        return values?.has(post.artifactId)
          ? (values.get(post.artifactId) ?? 0)
          : null;
      };
      return {
        ...post,
        impressions: metric("impressions"),
        reach: metric("reach"),
        likes: metric("likes"),
        comments: metric("comments"),
        shares: metric("shares"),
        saves: metric("saves"),
        sends: metric("sends"),
      };
    })
    .filter((post) =>
      metrics.some((metric) =>
        totalsByMetric.get(metric)?.has(post.artifactId),
      ),
    );
}

export function buildAnalyticsPeriodReport(
  snapshots: readonly AnalyticsSnapshot[],
  posts: readonly PostMetricsRow[],
  window: DateWindow,
): {
  summary: AnalyticsSummary;
  trend: AnalyticsTrendPoint[];
  posts: PostMetricsRow[];
} {
  const periodPosts = buildPeriodPostMetrics(snapshots, posts, window);
  return {
    summary: summarizePostMetrics(periodPosts),
    trend: buildAnalyticsTrend(snapshots).filter((point) =>
      isInWindow(point.date, window),
    ),
    posts: periodPosts,
  };
}

export function buildAnalyticsChangeInsight(
  current: AnalyticsSummary,
  previous: AnalyticsSummary | null,
): AnalyticsChangeInsight {
  const postLabel = `${current.posts.toLocaleString("en-US")} ${
    current.posts === 1 ? "post" : "posts"
  }`;
  if (previous === null) {
    return {
      headline: "All-time performance",
      detail: `Based on ${postLabel.replace("post", "tracked post")}.`,
      direction: "neutral",
    };
  }
  if (
    previous.impressions === 0 &&
    previous.engagements === 0 &&
    (current.impressions > 0 || current.engagements > 0)
  ) {
    return {
      headline: "First measured activity",
      detail: `Compared with the previous period · ${postLabel.replace(
        "post",
        "measured post",
      )}.`,
      direction: "up",
    };
  }

  const movements = [
    {
      label: "Impressions",
      current: current.impressions,
      previous: previous.impressions,
    },
    {
      label: "Engagements",
      current: current.engagements,
      previous: previous.engagements,
    },
  ]
    .filter((movement) => movement.previous > 0)
    .map((movement) => ({
      ...movement,
      percent: Math.round(
        ((movement.current - movement.previous) / movement.previous) * 100,
      ),
    }))
    .sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent));
  const strongest = movements[0];
  if (!strongest || strongest.percent === 0) {
    return {
      headline: "Performance held steady",
      detail: `Compared with the previous period · ${postLabel.replace(
        "post",
        "measured post",
      )}.`,
      direction: "neutral",
    };
  }
  return {
    headline: `${strongest.label} ${
      strongest.percent > 0 ? "increased" : "decreased"
    } ${Math.abs(strongest.percent).toLocaleString("en-US")}%`,
    detail: `Compared with the previous period · ${postLabel.replace(
      "post",
      "measured post",
    )}.`,
    direction: strongest.percent > 0 ? "up" : "down",
  };
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
    (total, post) => total + postEngagements(post),
    0,
  );
  const ratePosts = posts.filter(hasEngagementRateData);
  const rateImpressions = ratePosts.reduce(
    (total, post) => total + post.impressions,
    0,
  );
  const rateEngagements = ratePosts.reduce(
    (total, post) => total + postEngagements(post),
    0,
  );
  return {
    impressions,
    engagements,
    engagementRate:
      rateImpressions > 0
        ? Math.round((rateEngagements / rateImpressions) * 1000) / 10
        : null,
    posts: posts.length,
  };
}

export function postEngagements(post: PostMetricsRow): number {
  return ENGAGEMENT_METRICS.reduce(
    (total, metric) => total + (post[metric] ?? 0),
    0,
  );
}

export function postSavesAndShares(post: PostMetricsRow): number | null {
  if (post.saves === null || post.shares === null) return null;
  return post.saves + post.shares;
}

type EngagementRateRow = PostMetricsRow & {
  impressions: number;
};

function hasEngagementRateData(
  post: PostMetricsRow,
): post is EngagementRateRow {
  return (
    post.impressions !== null &&
    ENGAGEMENT_METRICS.some((metric) => post[metric] !== null)
  );
}

export function postEngagementRate(post: PostMetricsRow): number | null {
  if (!hasEngagementRateData(post) || post.impressions <= 0) {
    return null;
  }
  return Math.round((postEngagements(post) / post.impressions) * 1000) / 10;
}

function metricForPostSort(
  post: PostMetricsRow,
  sort: Exclude<PostPerformanceSort, "recent">,
): number | null {
  if (sort === "engagementRate") return postEngagementRate(post);
  if (sort === "savesAndShares") return postSavesAndShares(post);
  return post[sort];
}

export function filterAndSortPostPerformance(
  posts: readonly PostMetricsRow[],
  query: string,
  sort: PostPerformanceSort,
): PostMetricsRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? posts.filter((post) =>
        post.title.toLocaleLowerCase().includes(normalizedQuery),
      )
    : [...posts];
  if (sort === "recent") return sortPostsByRecency(filtered);

  return filtered.sort((a, b) => {
    const aValue = metricForPostSort(a, sort);
    const bValue = metricForPostSort(b, sort);
    if (aValue === null && bValue !== null) return 1;
    if (aValue !== null && bValue === null) return -1;
    if (aValue !== bValue) return (bValue ?? 0) - (aValue ?? 0);
    return comparePostsByRecency(a, b);
  });
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
export function metricAxisTicks(
  maxValue: number,
  divisions = 2,
): { top: number; ticks: number[] } {
  const top = niceCeil(Math.max(1, maxValue));
  const ticks: number[] = [];
  for (let i = divisions; i >= 0; i--) ticks.push((top / divisions) * i);
  return { top, ticks };
}

// Compatibility name for existing consumers and tests written when the chart
// only supported impressions.
export const impressionAxisTicks = metricAxisTicks;

// Order the analytics table with the most recent posts on top: publish date
// descending, undated posts last, ties broken by impressions (desc) so the
// order is deterministic. Sorts a copy; pure + exported for unit tests.
function comparePostsByRecency(a: PostMetricsRow, b: PostMetricsRow): number {
  const at = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
  const bt = b.publishedAt ? Date.parse(b.publishedAt) : NaN;
  const aValid = !Number.isNaN(at);
  const bValid = !Number.isNaN(bt);
  if (aValid && bValid && at !== bt) return bt - at;
  if (aValid !== bValid) return aValid ? -1 : 1; // dated before undated
  const impressionDifference = (b.impressions ?? 0) - (a.impressions ?? 0);
  if (impressionDifference !== 0) return impressionDifference;
  return a.artifactId.localeCompare(b.artifactId);
}

export function sortPostsByRecency(posts: PostMetricsRow[]): PostMetricsRow[] {
  return [...posts].sort(comparePostsByRecency);
}
