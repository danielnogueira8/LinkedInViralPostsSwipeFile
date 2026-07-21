"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  sortPostsByRecency,
  type PostMetricsRow,
  type TrendPoint,
} from "@/lib/analytics-view-model";

// Re-export the server-safe view-model so existing importers of "./view" (the
// server page, tests) keep working. The definitions themselves live in
// lib/analytics-view-model.ts (no "use client"), so the server page can call
// sortPostsByRecency without tripping the client-function-from-server error.
export {
  sortPostsByRecency,
  type PostMetricsRow,
  type TrendPoint,
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

export function AnalyticsView({
  posts,
  trend,
  lastFetchedAt,
  linkedInConnected,
  hasEligiblePublishedPosts,
}: {
  posts: PostMetricsRow[];
  trend: TrendPoint[];
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

  const totals = useMemo(() => {
    const sum = (pick: (p: PostMetricsRow) => number | null) =>
      posts.reduce((acc, p) => acc + (pick(p) ?? 0), 0);
    return {
      impressions: sum((p) => p.impressions),
      reactions: sum((p) => p.likes),
      comments: sum((p) => p.comments),
      shares: sum((p) => p.shares),
    };
  }, [posts]);

  const maxTrend = useMemo(
    () => Math.max(1, ...trend.map((t) => t.impressions)),
    [trend],
  );
  const emptyState = getAnalyticsEmptyState({
    linkedInConnected,
    postCount: posts.length,
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
          { label: "Impressions", value: totals.impressions },
          { label: "Reactions", value: totals.reactions },
          { label: "Comments", value: totals.comments },
          { label: "Shares", value: totals.shares },
        ].map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-card p-4">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              {fmt(t.value)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{t.label}</div>
          </div>
        ))}
      </div>

      {/* Impressions trend — simple CSS bars over the daily snapshot totals. */}
      {trend.length >= 2 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 text-sm font-medium text-foreground">
            Impressions over time
          </div>
          <div
            className="flex h-28 items-end gap-1"
            role="img"
            aria-label={`Bar chart of daily impressions from ${trend[0].date} to ${trend[trend.length - 1].date}, peaking at ${maxTrend.toLocaleString("en-US")} impressions.`}
          >
            {trend.map((t) => (
              <div
                key={t.date}
                aria-hidden="true"
                className="flex-1 rounded-t bg-primary/80 transition-[height]"
                style={{ height: `${Math.max(3, (t.impressions / maxTrend) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>{trend[0].date}</span>
            <span>{trend[trend.length - 1].date}</span>
          </div>
          {/* Non-visual access to the same data (screen readers, keyboard). */}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden list-none">
              View daily data
            </summary>
            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border/60">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">Date</th>
                    <th className="px-3 py-1.5 text-right font-medium">Impressions</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((t) => (
                    <tr key={t.date} className="border-b border-border/50 last:border-0">
                      <td className="px-3 py-1.5 tabular-nums">{t.date}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {t.impressions.toLocaleString("en-US")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}

      {/* Per-post table */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Post</th>
              <th className="px-3 py-2.5 text-right font-medium">Published</th>
              <th className="px-3 py-2.5 text-right font-medium">Impressions</th>
              <th className="px-3 py-2.5 text-right font-medium">Reach</th>
              <th className="px-3 py-2.5 text-right font-medium">Reactions</th>
              <th className="px-3 py-2.5 text-right font-medium">Comments</th>
              <th className="px-3 py-2.5 text-right font-medium">Shares</th>
              <th className="px-3 py-2.5 text-right font-medium">Saves</th>
              <th className="px-4 py-2.5 text-right font-medium">Sends</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.artifactId} className="border-b border-border/60 last:border-0">
                <td className="max-w-[320px] truncate px-4 py-2.5 text-foreground" title={p.title}>
                  {p.title}
                </td>
                <td className="px-3 py-2.5 text-right text-muted-foreground">
                  {fmtDate(p.publishedAt)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(p.impressions)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(p.reach)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(p.likes)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(p.comments)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(p.shares)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(p.saves)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{fmt(p.sends)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Covers posts published through SwipeIn only — LinkedIn doesn&apos;t expose
        metrics for posts published elsewhere.
      </p>
    </div>
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
