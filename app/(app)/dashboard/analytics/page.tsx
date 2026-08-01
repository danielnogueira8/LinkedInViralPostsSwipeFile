import { scopedSupabase } from "@/lib/supabase-scoped";
import { selectAllRows, selectInChunks } from "@/lib/db-paginate";
import { getConnection, canPublish } from "@/lib/publishing";
import { PageHeader, PageShell } from "@/components/app-surface";
import { SurfaceHelp } from "@/components/surface-help";
import { AnalyticsView } from "./view";
// Import the pure helpers + types from the server-safe module directly — NOT
// from "./view" (a "use client" module). Calling a client module's function on
// the server throws "Attempted to call sortPostsByRecency() from the server".
import {
  buildAnalyticsPeriodReport,
  filterAnalyticsContent,
  parseAnalyticsFilters,
  periodBounds,
  sortPostsByRecency,
  type AnalyticsSnapshot,
  type PostMetricsRow,
} from "@/lib/analytics-view-model";

export const dynamic = "force-dynamic";

// Shapes of the two paged reads below. Declared locally (rather than threading
// the generated Supabase generics) to keep the query builders from tripping
// TS2589 "type instantiation is excessively deep".
type AnalyticsSnapshotRow = {
  artifact_id: string;
  snapshot_date: string;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  sends: number | null;
  video_views: number | null;
  fetched_at: string | null;
};
type ArtifactRow = {
  id: string;
  title: string | null;
  body: string | null;
  published_at: string | null;
  kind: string | null;
};

// Analytics — LinkedIn performance of posts published THROUGH SwipeIn.
// Zernio only reports on posts it published, so posts published manually on
// LinkedIn never appear here; the copy frames the page accordingly. Data
// comes from the post_analytics snapshot table (refreshed daily by the cron,
// or on demand via the Refresh button), never from Zernio at page-view time.
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sb = await scopedSupabase();
  const filters = parseAnalyticsFilters(await searchParams);

  const [snapshotRows, connection, eligiblePostsRes] = await Promise.all([
    // Page past PostgREST's 1000-row cap. `.limit(5000)` did NOT lift it: the
    // response still stopped at 1000, and because the rows are date-ASCENDING
    // the truncation dropped the NEWEST snapshots — analytics froze at an old
    // date and silently stopped updating. One snapshot per published post per
    // day reaches 1000 in about ten weeks at 14 posts.
    selectAllRows<AnalyticsSnapshotRow>(() =>
      sb.raw
        .from("post_analytics")
        .select(
          "artifact_id, snapshot_date, impressions, reach, likes, comments, shares, saves, sends, video_views, fetched_at",
        )
        .eq("workspace_id", sb.workspaceId)
        .order("snapshot_date", { ascending: true }) as never,
    ),
    getConnection(sb.workspaceId, sb.raw),
    sb.raw
      .from("chat_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", sb.workspaceId)
      .eq("schedule_status", "published")
      .not("zernio_post_id", "is", null),
  ]);
  const snapshots = snapshotRows;

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
    // Chunk the id list: a long `.in(...)` makes PostgREST reject the request
    // with 400 "URL too long", which would blank the whole page.
    const artifacts = await selectInChunks<ArtifactRow>(artifactIds, (ids) =>
      sb.raw
        .from("chat_artifacts")
        .select("id, title, body, published_at, kind")
        .eq("workspace_id", sb.workspaceId)
        .in("id", ids) as never,
    );
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
          contentType:
            a.kind === "lead_magnet" ? "lead_magnet" : "regular",
          impressions: (m.impressions as number | null) ?? null,
          reach: (m.reach as number | null) ?? null,
          likes: (m.likes as number | null) ?? null,
          comments: (m.comments as number | null) ?? null,
          shares: (m.shares as number | null) ?? null,
          saves: (m.saves as number | null) ?? null,
          sends: (m.sends as number | null) ?? null,
        } satisfies PostMetricsRow;
      })
      .filter((p): p is PostMetricsRow => p !== null);
    // Most recent posts on top (was impressions-desc, which read as arbitrary).
    posts = sortPostsByRecency(posts);
  }
  // Snapshots are cumulative per post. Show the observed gains between
  // snapshots rather than summing cumulative account totals for each date.
  const metricSnapshots = snapshots.map(
      (snapshot) =>
        ({
          artifactId: snapshot.artifact_id as string,
          snapshotDate: snapshot.snapshot_date as string,
          impressions: (snapshot.impressions as number | null) ?? null,
          reach: (snapshot.reach as number | null) ?? null,
          likes: (snapshot.likes as number | null) ?? null,
          comments: (snapshot.comments as number | null) ?? null,
          shares: (snapshot.shares as number | null) ?? null,
          saves: (snapshot.saves as number | null) ?? null,
          sends: (snapshot.sends as number | null) ?? null,
        }) satisfies AnalyticsSnapshot,
    );
  const scoped = filterAnalyticsContent(
    posts,
    metricSnapshots,
    filters.contentType,
  );
  // Empty-state copy and connection gating must use the same content-type
  // scope as the report. Counting before this filter made a lead-magnet-only
  // view claim that regular posts were tracked too.
  const analyticsPostCount = scoped.posts.length;
  const today = new Date().toISOString().slice(0, 10);
  const bounds = periodBounds(filters.period, today);
  const currentReport = buildAnalyticsPeriodReport(
    scoped.snapshots,
    scoped.posts,
    bounds.current,
  );
  const previousSummary = bounds.previous
    ? buildAnalyticsPeriodReport(
        scoped.snapshots,
        scoped.posts,
        bounds.previous,
      ).summary
    : null;

  const lastFetchedAt = snapshots.length
    ? (snapshots[snapshots.length - 1].fetched_at as string)
    : null;

  return (
    <PageShell>
      <PageHeader
        title="Analytics"
        description="Track impressions, reach, and engagement for posts published through SwipeIn."
        meta={
          <SurfaceHelp title="LinkedIn performance of posts published through SwipeIn. Metrics come from your connected LinkedIn account (via Zernio) and refresh daily; posts published outside SwipeIn don't appear here." />
        }
      />
      <AnalyticsView
        posts={currentReport.posts}
        trend={currentReport.trend}
        summary={currentReport.summary}
        previousSummary={previousSummary}
        filters={filters}
        analyticsPostCount={analyticsPostCount}
        lastFetchedAt={lastFetchedAt}
        linkedInConnected={canPublish(connection)}
        hasEligiblePublishedPosts={(eligiblePostsRes.count ?? 0) > 0}
      />
    </PageShell>
  );
}
