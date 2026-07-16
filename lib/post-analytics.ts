import { supabaseAdmin } from "@/lib/supabase";
import {
  getLinkedInAnalytics,
  type ZernioPostAnalytics,
} from "@/lib/zernio";

// ---------------------------------------------------------------------------
// Post-analytics refresh: pull per-post LinkedIn metrics from Zernio and
// upsert one snapshot row per (artifact, day) into post_analytics.
//
// ONE Zernio call covers every post published under the API key (all
// workspaces); rows are joined back to chat_artifacts by zernio_post_id, so
// each metric lands in the workspace that owns the post — a post id Zernio
// reports that we don't know is simply skipped (it may belong to a different
// consumer of the same Zernio account, or a deleted draft).
//
// Best-effort by contract: callers (the daily cron) must not fail on an
// analytics hiccup. Look-back is capped — LinkedIn engagement flatlines after
// a couple of weeks, so refreshing the last 45 days keeps rows current while
// the snapshot history preserves older trends.
// ---------------------------------------------------------------------------

export const ANALYTICS_LOOKBACK_DAYS = 45;

type PublishedArtifact = {
  id: string;
  workspace_id: string;
  zernio_post_id: string;
};

export type AnalyticsRefreshSummary = {
  reported: number; // posts Zernio returned
  matched: number; // reported posts that map to one of our artifacts
  upserted: number;
  // TEMPORARY diagnostic (only set when reported>0 but matched===0): surfaces the
  // id shapes on BOTH sides of the join so we can see WHY Zernio's analytics posts
  // don't match our stored zernio_post_id. Exposes only id-ish keys/values of the
  // caller's own posts. Remove once the id-match fix lands.
  debug?: {
    expectedIds: string[]; // our zernio_post_id values (from publish)
    reportedIdKeys: Array<Record<string, unknown>>; // per reported post: its raw keys + id-ish values
  };
};

// Pure join+row-shaping (exported for unit tests): map Zernio's report onto
// our published artifacts, producing upsert-ready snapshot rows.
export function buildAnalyticsSnapshotRows(
  reports: ZernioPostAnalytics[],
  artifacts: PublishedArtifact[],
  snapshotDate: string, // YYYY-MM-DD
): Array<Record<string, unknown>> {
  const byPostId = new Map(artifacts.map((a) => [a.zernio_post_id, a]));
  const rows: Array<Record<string, unknown>> = [];
  for (const r of reports) {
    const artifact = byPostId.get(r.postId);
    if (!artifact) continue;
    rows.push({
      workspace_id: artifact.workspace_id,
      artifact_id: artifact.id,
      zernio_post_id: r.postId,
      snapshot_date: snapshotDate,
      impressions: r.impressions,
      reach: r.reach,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      saves: r.saves,
      sends: r.sends,
      video_views: r.videoViews,
      raw: r.raw,
      fetched_at: new Date().toISOString(),
    });
  }
  return rows;
}

// Refresh snapshots for every workspace's recently-published posts. Throws on
// hard failure; the cron call site wraps it best-effort.
export async function refreshPostAnalytics(
  now: Date = new Date(),
): Promise<AnalyticsRefreshSummary> {
  const sb = supabaseAdmin();
  const fromDate = new Date(
    now.getTime() - ANALYTICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const toDate = now.toISOString().slice(0, 10);

  // Our side of the join: published artifacts with a Zernio post id in the
  // look-back window.
  const { data: artifacts, error: artErr } = await sb
    .from("chat_artifacts")
    .select("id, workspace_id, zernio_post_id")
    .not("zernio_post_id", "is", null)
    .eq("schedule_status", "published")
    .gte("published_at", `${fromDate}T00:00:00Z`);
  if (artErr) throw artErr;
  const published = (artifacts ?? []).filter(
    (a): a is PublishedArtifact => typeof a.zernio_post_id === "string",
  );
  if (published.length === 0) {
    return { reported: 0, matched: 0, upserted: 0 };
  }

  const reports = await getLinkedInAnalytics({ fromDate, toDate });
  const rows = buildAnalyticsSnapshotRows(reports, published, toDate);
  if (rows.length === 0) {
    // TEMPORARY: Zernio returned posts but none matched our zernio_post_id. Dump
    // the id shapes on both sides so we can see the mismatch. Remove after the fix.
    const debug =
      reports.length > 0
        ? {
            expectedIds: published.map((p) => p.zernio_post_id),
            reportedIdKeys: reports.map((r) => {
              const o = r.raw ?? {};
              const idish: Record<string, unknown> = { parsedPostId: r.postId };
              for (const [k, v] of Object.entries(o)) {
                if (
                  /id|urn|share|activity|post|_id/i.test(k) &&
                  (typeof v === "string" || typeof v === "number")
                ) {
                  idish[k] = v;
                }
              }
              idish.__allKeys = Object.keys(o);
              return idish;
            }),
          }
        : undefined;
    return { reported: reports.length, matched: 0, upserted: 0, debug };
  }

  // Upsert on (artifact_id, snapshot_date): re-running the same day updates
  // the day's snapshot in place instead of duplicating it.
  const { error: upErr } = await sb
    .from("post_analytics")
    .upsert(rows, { onConflict: "artifact_id,snapshot_date" });
  if (upErr) throw upErr;

  return { reported: reports.length, matched: rows.length, upserted: rows.length };
}
