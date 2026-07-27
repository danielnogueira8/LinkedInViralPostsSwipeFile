"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleHelp,
  ExternalLink,
  Minus,
  RefreshCw,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ANALYTICS_CONTENT_TYPE_OPTIONS,
  ANALYTICS_PERIOD_OPTIONS,
  ANALYTICS_TREND_METRIC_OPTIONS,
  ENGAGEMENT_RATE_HELP,
  POST_PERFORMANCE_SORT_OPTIONS,
  buildAnalyticsChangeInsight,
  filterAndSortPostPerformance,
  metricAxisTicks,
  postEngagementRate,
  postSavesAndShares,
  type AnalyticsContentType,
  type AnalyticsFilters,
  type AnalyticsPeriod,
  type AnalyticsSummary,
  type AnalyticsTrendMetric,
  type AnalyticsTrendPoint,
  type PostMetricsRow,
  type PostPerformanceSort,
} from "@/lib/analytics-view-model";

// Re-export the server-safe view-model so existing importers of "./view" (the
// server page, tests) keep working. The definitions themselves live in
// lib/analytics-view-model.ts (no "use client"), so the server page can call
// sortPostsByRecency without tripping the client-function-from-server error.
export {
  sortPostsByRecency,
  niceCeil,
  impressionAxisTicks,
  type PostMetricsRow,
  type AnalyticsTrendPoint,
} from "@/lib/analytics-view-model";

export type AnalyticsEmptyState = "connect" | "awaiting_first_fetch" | "no_posts" | null;

export function getAnalyticsEmptyState(opts: {
  linkedInConnected: boolean;
  postCount: number;
  hasEligiblePublishedPosts: boolean;
}): AnalyticsEmptyState {
  if (opts.postCount > 0) return null;
  if (!opts.linkedInConnected) return "connect";
  return opts.hasEligiblePublishedPosts ? "awaiting_first_fetch" : "no_posts";
}

function fmt(n: number | null): string {
  if (n === null) return "—";
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function formatComparison(
  current: number | null,
  previous: number | null,
  kind: "percent" | "points" = "percent",
): string | null {
  if (current === null || previous === null) return null;
  if (kind === "points") {
    const change = Math.round((current - previous) * 10) / 10;
    if (change === 0) return "No change";
    return `${change > 0 ? "+" : ""}${change.toLocaleString("en-US")} pp`;
  }
  if (previous === 0) return current > 0 ? "New" : "No change";
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return "No change";
  return `${change > 0 ? "+" : ""}${change.toLocaleString("en-US")}%`;
}

function analyticsHref(
  period: AnalyticsPeriod,
  contentType: AnalyticsContentType,
): string {
  const params = new URLSearchParams();
  if (period !== "30d") params.set("period", period);
  if (contentType !== "all") params.set("type", contentType);
  const query = params.toString();
  return query ? `/dashboard/analytics?${query}` : "/dashboard/analytics";
}

export function AnalyticsView({
  posts,
  trend,
  summary,
  previousSummary,
  filters,
  analyticsPostCount,
  lastFetchedAt,
  linkedInConnected,
  hasEligiblePublishedPosts,
}: {
  posts: PostMetricsRow[];
  trend: AnalyticsTrendPoint[];
  summary: AnalyticsSummary;
  previousSummary: AnalyticsSummary | null;
  filters: AnalyticsFilters;
  analyticsPostCount: number;
  lastFetchedAt: string | null;
  linkedInConnected: boolean;
  hasEligiblePublishedPosts: boolean;
}) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setNotice(null);
    try {
      const res = await fetch("/api/analytics/refresh", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        setNotice(data.error || "Refresh failed — try again later.");
      } else {
        setNotice(null);
        router.refresh();
      }
    } catch {
      setNotice("Refresh failed — check your connection and try again.");
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, router]);

  const changeInsight = useMemo(
    () => buildAnalyticsChangeInsight(summary, previousSummary),
    [previousSummary, summary],
  );
  const emptyState = getAnalyticsEmptyState({
    linkedInConnected,
    postCount: analyticsPostCount,
    hasEligiblePublishedPosts,
  });

  // ---- Empty states -------------------------------------------------------
  if (emptyState === "connect") {
    return (
      <EmptyCard
        title="Connect LinkedIn to see analytics"
        body="Analytics covers posts published through SwipeIn. Connect your LinkedIn account in Settings, schedule a post, and metrics will start appearing here after it publishes."
        cta={{ href: "/dashboard/settings", label: "Open Settings" }}
      />
    );
  }
  if (emptyState) {
    if (emptyState === "awaiting_first_fetch") {
      return (
        <EmptyCard
          title="Analytics are ready to fetch"
          body="You have published posts through SwipeIn, but their LinkedIn metrics have not been fetched yet."
          action={{ label: "Fetch analytics", onClick: refresh, loading: refreshing }}
          notice={notice}
        />
      );
    }
    return (
      <EmptyCard
        title="No published posts yet"
        body="Once a scheduled post publishes to LinkedIn through SwipeIn, its impressions, reactions, comments, and shares show up here (refreshed daily). Posts published outside SwipeIn don't appear."
        cta={{ href: "/dashboard/posts", label: "Go to Posts" }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
        aria-label="Analytics filters"
      >
        <div className="flex flex-wrap gap-1" aria-label="Reporting period">
          {ANALYTICS_PERIOD_OPTIONS.map(({ value: period, label }) => (
            <Link
              key={period}
              href={analyticsHref(period, filters.contentType)}
              aria-current={filters.period === period ? "page" : undefined}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                filters.period === period
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" aria-label="Post type">
          {ANALYTICS_CONTENT_TYPE_OPTIONS.map(
            ({ value: contentType, label }) => (
              <Link
                key={contentType}
                href={analyticsHref(filters.period, contentType)}
                aria-current={
                  filters.contentType === contentType ? "page" : undefined
                }
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  filters.contentType === contentType
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {label}
              </Link>
            ),
          )}
        </div>
      </div>

      {/* Toolbar: freshness + manual refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {lastFetchedAt
            ? `Last refreshed ${new Date(lastFetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · refreshes daily`
            : "Refreshes daily"}
        </p>
        <div className="flex items-center gap-3">
          {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          {
            key: "impressions",
            label: filters.period === "all" ? "Lifetime impressions" : "Impressions",
            value: fmt(summary.impressions),
            comparison: formatComparison(
              summary.impressions,
              previousSummary?.impressions ?? null,
            ),
          },
          {
            key: "engagements",
            label: filters.period === "all" ? "Lifetime engagements" : "Engagements",
            value: fmt(summary.engagements),
            comparison: formatComparison(
              summary.engagements,
              previousSummary?.engagements ?? null,
            ),
          },
          {
            key: "engagement-rate",
            label: "Engagement rate",
            help: true,
            value:
              summary.engagementRate === null
                ? "—"
                : `${summary.engagementRate.toLocaleString("en-US")}%`,
            comparison: formatComparison(
              summary.engagementRate,
              previousSummary?.engagementRate ?? null,
              "points",
            ),
          },
          {
            key: "posts",
            label: filters.period === "all" ? "Tracked posts" : "Measured posts",
            value: fmt(summary.posts),
            comparison: formatComparison(
              summary.posts,
              previousSummary?.posts ?? null,
            ),
          },
        ].map((t) => (
          <div key={t.key} className="rounded-xl border border-border bg-card p-4">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              {t.value}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                {t.help ? (
                  <EngagementRateHelp />
                ) : (
                  t.label
                )}
              </span>
              {t.comparison && (
                <span className="font-medium text-foreground">
                  {t.comparison} vs previous
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        Engagements include reactions, comments, shares, saves, and sends.
        Engagement rate is engagements divided by impressions.
      </p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(240px,1fr)]">
        <PerformanceTrendCard trend={trend} />
        <aside className="flex min-h-52 flex-col rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            {changeInsight.direction === "up" ? (
              <ArrowUpRight className="h-4 w-4 text-emerald-600" />
            ) : changeInsight.direction === "down" ? (
              <ArrowDownRight className="h-4 w-4 text-amber-600" />
            ) : (
              <Minus className="h-4 w-4 text-muted-foreground" />
            )}
            What changed
          </div>
          <p className="mt-7 text-xl font-semibold leading-snug text-foreground">
            {changeInsight.headline}
          </p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {changeInsight.detail}
          </p>
          <p className="mt-auto border-t border-border/70 pt-4 text-xs leading-5 text-muted-foreground">
            Directional signal only. More measured posts make comparisons more
            reliable.
          </p>
        </aside>
      </div>

      <PostPerformanceSection posts={posts} period={filters.period} />

      <p className="text-xs text-muted-foreground">
        Covers posts published through SwipeIn only — LinkedIn doesn&apos;t expose
        metrics for posts published elsewhere.
      </p>
    </div>
  );
}

function contentTypeLabel(contentType: PostMetricsRow["contentType"]): string {
  return contentType === "lead_magnet" ? "Lead magnet" : "Regular";
}

function fmtRate(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("en-US")}%`;
}

const POST_PERFORMANCE_METRICS = [
  {
    key: "impressions",
    label: "Impressions",
    format: (post: PostMetricsRow) => fmt(post.impressions),
  },
  {
    key: "engagement-rate",
    label: "Engagement rate",
    help: true,
    format: (post: PostMetricsRow) => fmtRate(postEngagementRate(post)),
  },
  {
    key: "comments",
    label: "Comments",
    format: (post: PostMetricsRow) => fmt(post.comments),
  },
  {
    key: "saves-and-shares",
    label: "Saves + shares",
    format: (post: PostMetricsRow) => fmt(postSavesAndShares(post)),
  },
] as const;

function EngagementRateHelp({
  align = "left",
  placement = "bottom",
  showLabel = true,
}: {
  align?: "left" | "right";
  placement?: "top" | "bottom";
  showLabel?: boolean;
}) {
  const id = useId();
  return (
    <span className="relative inline-flex items-center gap-1">
      {showLabel && <span>Engagement rate</span>}
      <button
        type="button"
        aria-label="How engagement rate is calculated"
        aria-describedby={id}
        className={cn(
          "peer inline-grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground",
          "hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/40",
        )}
      >
        <CircleHelp className="size-3.5" aria-hidden="true" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-30 w-64 rounded-lg border border-border",
          "bg-popover px-2.5 py-2 text-left text-[11px] font-normal leading-4 text-popover-foreground shadow-md",
          "opacity-0 transition-opacity peer-hover:opacity-100 peer-focus-visible:opacity-100",
          "motion-reduce:transition-none",
          align === "right" ? "right-0" : "left-0",
          placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {ENGAGEMENT_RATE_HELP}
      </span>
    </span>
  );
}

export function PostPerformanceSection({
  posts,
  period,
}: {
  posts: PostMetricsRow[];
  period: AnalyticsPeriod;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PostPerformanceSort>("recent");
  const visiblePosts = useMemo(
    () => filterAndSortPostPerformance(posts, query, sort),
    [posts, query, sort],
  );
  const periodLabel =
    period === "all"
      ? "lifetime totals"
      : `activity captured in the selected ${period.toUpperCase()} window`;

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Post performance
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Compare {periodLabel}. Open any title to view the exact post.
          </p>
        </div>
        <div
          className="mt-4 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_180px]"
          role="group"
          aria-label="Post performance controls"
        >
          <label className="relative min-w-0">
            <span className="sr-only">Search posts</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search posts"
              className="h-10 w-full min-w-0 rounded-lg border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </label>
          <div className="flex min-w-0 items-center gap-1.5">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Sort posts</span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as PostPerformanceSort)
                }
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {POST_PERFORMANCE_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <EngagementRateHelp align="right" showLabel={false} />
          </div>
        </div>
      </div>

      {visiblePosts.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <p className="text-sm font-medium text-foreground">
            No matching posts
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try a different title or clear your search.
          </p>
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mt-4 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              Clear search
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Post</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Published
                  </th>
                  {POST_PERFORMANCE_METRICS.map((metric, index) => (
                    <th
                      key={metric.key}
                      className={cn(
                        "px-3 py-2.5 text-right font-medium",
                        index === POST_PERFORMANCE_METRICS.length - 1 && "pr-4",
                      )}
                    >
                      {"help" in metric && metric.help ? (
                        <EngagementRateHelp align="right" />
                      ) : (
                        metric.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visiblePosts.map((post) => (
                  <tr
                    key={post.artifactId}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="max-w-[360px] px-4 py-3">
                      <Link
                        href={`/dashboard/posts?open=${encodeURIComponent(
                          post.artifactId,
                        )}`}
                        className="group block min-w-0 text-foreground hover:underline"
                      >
                        <span
                          className="block truncate font-medium"
                          title={post.title}
                        >
                          {post.title}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {contentTypeLabel(post.contentType)}
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-right text-muted-foreground">
                      {fmtDate(post.publishedAt)}
                    </td>
                    {POST_PERFORMANCE_METRICS.map((metric, index) => (
                      <td
                        key={metric.key}
                        className={cn(
                          "px-3 py-3 text-right tabular-nums",
                          index === POST_PERFORMANCE_METRICS.length - 1 &&
                            "pr-4",
                        )}
                      >
                        {metric.format(post)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-border md:hidden">
            {visiblePosts.map((post) => (
              <article
                key={post.artifactId}
                className="p-4 transition-colors hover:bg-accent/40"
              >
                <Link
                  href={`/dashboard/posts?open=${encodeURIComponent(
                    post.artifactId,
                  )}`}
                  className="flex min-w-0 items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-medium leading-5 text-foreground">
                      {post.title}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {contentTypeLabel(post.contentType)} ·{" "}
                      {fmtDate(post.publishedAt)}
                    </p>
                  </div>
                  <ExternalLink
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  />
                </Link>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                  {POST_PERFORMANCE_METRICS.map((metric) => (
                    <div key={metric.key}>
                      <dt className="text-[11px] text-muted-foreground">
                        {"help" in metric && metric.help ? (
                          <EngagementRateHelp
                            align="right"
                            placement="top"
                          />
                        ) : (
                          metric.label
                        )}
                      </dt>
                      <dd className="mt-0.5 text-sm font-medium tabular-nums text-foreground">
                        {metric.format(post)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function trendValue(
  point: AnalyticsTrendPoint,
  metric: AnalyticsTrendMetric,
): number | null {
  return point[metric];
}

function formatTrendValue(
  value: number | null,
  metric: AnalyticsTrendMetric,
): string {
  if (value === null) return "—";
  return metric === "engagementRate"
    ? `${value.toLocaleString("en-US")}%`
    : fmt(value);
}

export function PerformanceTrendCard({
  trend,
}: {
  trend: AnalyticsTrendPoint[];
}) {
  const engagementRateHelpId = useId();
  const [metric, setMetric] = useState<AnalyticsTrendMetric>("impressions");
  const [engagementRateHelpVisible, setEngagementRateHelpVisible] =
    useState(false);
  const [hoveredBar, setHoveredBar] = useState<number | null>(null);
  const option = ANALYTICS_TREND_METRIC_OPTIONS.find(
    (candidate) => candidate.value === metric,
  )!;
  const measuredTrend = useMemo(
    () => trend.filter((point) => trendValue(point, metric) !== null),
    [metric, trend],
  );
  const values = useMemo(
    () => measuredTrend.map((point) => trendValue(point, metric) as number),
    [measuredTrend, metric],
  );
  const axis = useMemo(
    () => metricAxisTicks(Math.max(1, ...values)),
    [values],
  );

  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">
            Performance trend
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            New activity captured between daily snapshots.
          </p>
        </div>
        <div className="relative">
          <div
            className="-mx-1 flex w-full gap-1 overflow-x-auto px-1 pb-1 sm:mx-0 sm:px-0"
            role="group"
            aria-label="Chart metric"
          >
            {ANALYTICS_TREND_METRIC_OPTIONS.map((candidate) => {
              const isEngagementRate =
                candidate.value === "engagementRate";
              return (
                <button
                  key={candidate.value}
                  type="button"
                  aria-pressed={metric === candidate.value}
                  aria-describedby={
                    isEngagementRate ? engagementRateHelpId : undefined
                  }
                  onClick={() => setMetric(candidate.value)}
                  onMouseEnter={() =>
                    isEngagementRate && setEngagementRateHelpVisible(true)
                  }
                  onMouseLeave={() =>
                    isEngagementRate && setEngagementRateHelpVisible(false)
                  }
                  onFocus={() =>
                    isEngagementRate && setEngagementRateHelpVisible(true)
                  }
                  onBlur={() =>
                    isEngagementRate && setEngagementRateHelpVisible(false)
                  }
                  className={cn(
                    "shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                    metric === candidate.value
                      ? "bg-foreground text-background"
                      : "bg-muted/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {candidate.label}
                </button>
              );
            })}
          </div>
          <span
            id={engagementRateHelpId}
            role="tooltip"
            className={cn(
              "pointer-events-none absolute right-0 top-full z-30 mt-1.5 w-64 rounded-lg border border-border",
              "bg-popover px-2.5 py-2 text-left text-[11px] leading-4 text-popover-foreground shadow-md",
              "transition-opacity motion-reduce:transition-none",
              engagementRateHelpVisible ? "opacity-100" : "opacity-0",
            )}
          >
            {ENGAGEMENT_RATE_HELP}
          </span>
        </div>
      </div>

      {measuredTrend.length < 2 ? (
        <div className="grid h-52 place-items-center text-center">
          <div>
            <p className="text-sm font-medium text-foreground">
              Not enough daily changes yet
            </p>
            <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
              At least two measured days are needed to draw a useful trend.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div
            className="mt-6 flex gap-3"
            aria-label={`${option.label} trend from ${measuredTrend[0].date} to ${
              measuredTrend[measuredTrend.length - 1].date
            }`}
          >
            <div className="flex h-44 w-11 shrink-0 flex-col justify-between py-0.5 text-right text-[10px] leading-none text-muted-foreground tabular-nums">
              {axis.ticks.map((tick) => (
                <span key={tick}>{formatTrendValue(tick, metric)}</span>
              ))}
            </div>

            <div className="relative min-w-0 flex-1">
              <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                {axis.ticks.map((tick, index) => (
                  <div
                    key={tick}
                    className={cn(
                      "h-px w-full",
                      index === axis.ticks.length - 1
                        ? "bg-border"
                        : "bg-border/50",
                    )}
                  />
                ))}
              </div>

              <div className="relative flex h-44 items-end gap-[2px]">
                {measuredTrend.map((point, index) => {
                  const value = trendValue(point, metric);
                  const pct = ((value ?? 0) / axis.top) * 100;
                  const active = hoveredBar === index;
                  return (
                    <div
                      key={point.date}
                      className="group relative flex h-full min-w-0 flex-1 items-end justify-center"
                      onMouseEnter={() => setHoveredBar(index)}
                      onMouseLeave={() =>
                        setHoveredBar((current) =>
                          current === index ? null : current,
                        )
                      }
                    >
                      {active && (
                        <div
                          role="tooltip"
                          className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-center shadow-md"
                        >
                          <div className="text-xs font-semibold text-popover-foreground tabular-nums">
                            {formatTrendValue(value, metric)}
                          </div>
                          <div className="text-[10px] text-muted-foreground tabular-nums">
                            {point.date}
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        aria-label={`${point.date}: ${formatTrendValue(
                          value,
                          metric,
                        )} ${option.label.toLowerCase()}`}
                        onFocus={() => setHoveredBar(index)}
                        onBlur={() =>
                          setHoveredBar((current) =>
                            current === index ? null : current,
                          )
                        }
                        className={cn(
                          "w-full max-w-[22px] rounded-t-[4px] transition-[height,background-color] outline-none",
                          "focus-visible:ring-2 focus-visible:ring-ring/50",
                          active
                            ? "bg-primary"
                            : "bg-primary/70 hover:bg-primary",
                        )}
                        style={{ height: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-2 flex justify-between pl-14 text-xs text-muted-foreground tabular-nums">
            <span>{measuredTrend[0].date}</span>
            <span>{measuredTrend[measuredTrend.length - 1].date}</span>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              View daily data
            </summary>
            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border/60">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">Date</th>
                    <th className="px-3 py-1.5 text-right font-medium">
                      {option.label}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {measuredTrend.map((point) => (
                    <tr
                      key={point.date}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="px-3 py-1.5 tabular-nums">
                        {point.date}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatTrendValue(trendValue(point, metric), metric)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function EmptyCard({
  title,
  body,
  cta,
  action,
  notice,
}: {
  title: string;
  body: string;
  cta?: { href: string; label: string };
  action?: { label: string; onClick: () => void; loading: boolean };
  notice?: string | null;
}) {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{body}</p>
      {cta && (
        <Link
          href={cta.href}
          className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          {cta.label}
        </Link>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.loading}
          className="mt-2 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", action.loading && "animate-spin")} />
          {action.loading ? "Fetching…" : action.label}
        </button>
      )}
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    </div>
  );
}
