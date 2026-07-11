"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

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
}: {
  posts: PostMetricsRow[];
  trend: TrendPoint[];
  lastFetchedAt: string | null;
  linkedInConnected: boolean;
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

  // ---- Empty states -------------------------------------------------------
  if (!linkedInConnected && posts.length === 0) {
    return (
      <EmptyCard
        title="Connect LinkedIn to see analytics"
        body="Analytics covers posts published through SwipeIn. Connect your LinkedIn account in Settings, schedule a post, and metrics will start appearing here after it publishes."
        cta={{ href: "/dashboard/settings", label: "Open Settings" }}
      />
    );
  }
  if (posts.length === 0) {
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
          <div className="flex h-28 items-end gap-1">
            {trend.map((t) => (
              <div
                key={t.date}
                title={`${t.date}: ${t.impressions.toLocaleString("en-US")} impressions`}
                className="flex-1 rounded-t bg-primary/80 transition-[height]"
                style={{ height: `${Math.max(3, (t.impressions / maxTrend) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
            <span>{trend[0].date}</span>
            <span>{trend[trend.length - 1].date}</span>
          </div>
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
                <td className="max-w-[320px] truncate px-4 py-2.5 text-foreground">
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
}: {
  title: string;
  body: string;
  cta: { href: string; label: string };
}) {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{body}</p>
      <Link
        href={cta.href}
        className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
      >
        {cta.label}
      </Link>
    </div>
  );
}
