import { scopedSupabase } from "@/lib/supabase-scoped";
import { getConnection, canPublish } from "@/lib/publishing";
import { PageHeader, PageShell } from "@/components/app-surface";
import { SurfaceHelp } from "@/components/surface-help";
import { AnalyticsView, type PostMetricsRow, type TrendPoint } from "./view";

export const dynamic = "force-dynamic";

// Analytics — LinkedIn performance of posts published THROUGH SwipeIn.
// Zernio only reports on posts it published, so posts published manually on
// LinkedIn never appear here; the copy frames the page accordingly. Data
// comes from the post_analytics snapshot table (refreshed daily by the cron,
// or on demand via the Refresh button), never from Zernio at page-view time.
export default async function AnalyticsPage() {
  const sb = await scopedSupabase();

  const [snapshotsRes, connection, eligiblePostsRes] = await Promise.all([
    sb.raw
      .from("post_analytics")
      .select(
        "artifact_id, snapshot_date, impressions, reach, likes, comments, shares, saves, sends, video_views, fetched_at",
      )
      .eq("workspace_id", sb.workspaceId)
      .order("snapshot_date", { ascending: true })
      .limit(5000),
    getConnection(sb.workspaceId),
    sb.raw
      .from("chat_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", sb.workspaceId)
      .eq("schedule_status", "published")
      .not("zernio_post_id", "is", null),
  ]);
  const snapshots = snapshotsRes.data ?? [];

  // Latest snapshot per artifact = the post's current numbers (rows are
  // date-ascending, so the last write per artifact wins).
  const latestByArtifact = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    latestByArtifact.set(s.artifact_id as string, s);
  }

  // Join titles/bodies for the table.
  const artifactIds = [...latestByArtifact.keys()];
  let posts: PostMetricsRow[] = [];
  if (artifactIds.length) {
    const { data: artifacts } = await sb.raw
      .from("chat_artifacts")
      .select("id, title, body, published_at")
      .eq("workspace_id", sb.workspaceId)
      .in("id", artifactIds);
    posts = (artifacts ?? [])
      .map((a) => {
        const m = latestByArtifact.get(a.id as string);
        if (!m) return null;
        const body = typeof a.body === "string" ? a.body : "";
        return {
          artifactId: a.id as string,
          title:
            (a.title as string | null) ||
            body.split("\n")[0].slice(0, 80) ||
            "Untitled post",
          publishedAt: (a.published_at as string | null) ?? null,
          impressions: (m.impressions as number | null) ?? null,
          reach: (m.reach as number | null) ?? null,
          likes: (m.likes as number | null) ?? null,
          comments: (m.comments as number | null) ?? null,
          shares: (m.shares as number | null) ?? null,
          saves: (m.saves as number | null) ?? null,
          sends: (m.sends as number | null) ?? null,
        } satisfies PostMetricsRow;
      })
      .filter((p): p is PostMetricsRow => p !== null)
      .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0));
  }

  // Daily impressions trend (last 30 days): sum each day's snapshots. Days
  // without a snapshot are omitted (the chart renders what exists).
  const byDay = new Map<string, number>();
  for (const s of snapshots) {
    const day = s.snapshot_date as string;
    byDay.set(day, (byDay.get(day) ?? 0) + ((s.impressions as number | null) ?? 0));
  }
  const trend: TrendPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-30)
    .map(([date, impressions]) => ({ date, impressions }));

  const lastFetchedAt = snapshots.length
    ? (snapshots[snapshots.length - 1].fetched_at as string)
    : null;

  return (
    <PageShell>
      <PageHeader
        title="Analytics"
        meta={
          <SurfaceHelp title="LinkedIn performance of posts published through SwipeIn. Metrics come from your connected LinkedIn account (via Zernio) and refresh daily; posts published outside SwipeIn don't appear here." />
        }
      />
      <AnalyticsView
        posts={posts}
        trend={trend}
        lastFetchedAt={lastFetchedAt}
        linkedInConnected={canPublish(connection)}
        hasEligiblePublishedPosts={(eligiblePostsRes.count ?? 0) > 0}
      />
    </PageShell>
  );
}
