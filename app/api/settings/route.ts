import { NextResponse } from "next/server";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { selectAllRows } from "@/lib/db-paginate";
import { z } from "zod";

export const runtime = "nodejs";

const pairSchema = z.object({
  min_reactions: z.number().int().min(0),
  min_comments: z.number().int().min(0),
});

const bodySchema = z.object({
  viral: pairSchema,
  template: pairSchema,
});

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data } = await sb
      .settings()
      .in("key", ["viral_thresholds", "template_thresholds"]);
    const byKey = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
    // Fallbacks must match DEFAULT_VIRAL / DEFAULT_TEMPLATE in lib/viral.ts so
    // a workspace that never changed its settings sees the SAME numbers here
    // (settings page) and in the pipeline (is_viral evaluation).
    return NextResponse.json({
      ok: true,
      viral: byKey.viral_thresholds ?? { min_reactions: 50, min_comments: 50 },
      template: byKey.template_thresholds ?? { min_reactions: 500, min_comments: 100 },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    const sb = await scopedSupabase();

    const [r1, r2] = await Promise.all([
      sb.upsertSetting("viral_thresholds", parsed.data.viral),
      sb.upsertSetting("template_thresholds", parsed.data.template),
    ]);
    if (r1.error || r2.error) {
      return errorResponse(r1.error || r2.error);
    }

    // Re-evaluate is_viral for posts from accounts THIS workspace tracks.
    // `is_viral` is global today; this still works for the single-workspace
    // case and remains the right behavior since each scrape is global anyway.
    // (Future: per-workspace is_viral as a derived view rather than a column.)
    //
    // Two bulk updates rather than a per-row loop — the old loop issued N
    // sequential UPDATEs and would time out for workspaces with thousands of
    // posts. PostgREST's filter set lets us flip `is_viral` for the matching
    // and non-matching slices in two round-trips, atomically per-slice.
    const accountIds = await trackedAccountIds(sb.workspaceId);
    if (accountIds.length > 0) {
      const { min_reactions, min_comments } = parsed.data.viral;
      // A post is viral when EITHER metric meets its threshold. The two updates
      // below must be exact complements so every tracked post is reclassified —
      // otherwise a post left out of both slices keeps a stale `is_viral`.
      //
      // The trap is NULL: a failed scrape leaves reactions/comments null, and in
      // SQL/PostgREST `null >= X` and `null < X` are BOTH unknown (never true).
      // The old `.lt(reactions).lt(comments)` "false" slice therefore skipped
      // every null-metric post, so demoted posts stayed flagged viral forever.
      //
      // Fix: treat null as "below threshold" explicitly.
      //   viral  = reactions >= min  OR  comments >= min
      //   !viral = (reactions < min OR reactions is null)
      //            AND (comments < min OR comments is null)
      const viralFilter = `reactions.gte.${min_reactions},comments.gte.${min_comments}`;
      const [upTrue, upFalse] = await Promise.all([
        sb.raw
          .from("posts")
          .update({ is_viral: true })
          .in("account_id", accountIds)
          .or(viralFilter),
        sb.raw
          .from("posts")
          .update({ is_viral: false })
          .in("account_id", accountIds)
          // Grouped AND-of-ORs: each metric is "below threshold or missing".
          .or(`reactions.lt.${min_reactions},reactions.is.null`)
          .or(`comments.lt.${min_comments},comments.is.null`),
      ]);
      if (upTrue.error || upFalse.error) {
        return errorResponse(upTrue.error || upFalse.error);
      }

      // Foundation for per-workspace classification (migration-075): also
      // reclassify workspace_post_classification for THIS workspace's own
      // tracked posts. Scoped strictly to sb.workspaceId — unlike the global
      // updates above, this can NEVER affect another workspace's rows, which
      // is the entire point (the global updates above are the bug this table
      // exists to eventually replace). Best-effort: nothing here should block
      // the settings save the user is actually waiting on.
      // Paginated: a workspace with more than 1000 tracked posts would
      // otherwise only get the first 1000 reclassified on a threshold change
      // (the silent 1000-row cap). accountIds is a single workspace's ~50
      // tracked accounts, so the `.in()` itself is well under the URL limit.
      let ownPosts: Array<{ id: string; reactions: number | null; comments: number | null }>;
      try {
        ownPosts = await selectAllRows(() =>
          sb.raw.from("posts").select("id, reactions, comments").in("account_id", accountIds),
        );
      } catch (e) {
        console.warn(
          `workspace_post_classification read failed for ${sb.workspaceId}: ${(e as Error).message}`,
        );
        ownPosts = [];
      }
      if (ownPosts.length) {
        const rows = ownPosts.map((p) => ({
          workspace_id: sb.workspaceId,
          post_id: p.id,
          is_viral:
            (p.reactions ?? 0) >= min_reactions || (p.comments ?? 0) >= min_comments,
          viral_basis: "flat_threshold",
          computed_at: new Date().toISOString(),
        }));
        const { error: classifyErr } = await sb.raw
          .from("workspace_post_classification")
          .upsert(rows, { onConflict: "workspace_id,post_id" });
        if (classifyErr) {
          console.warn(
            `workspace_post_classification bulk reclassify failed for ${sb.workspaceId}: ${classifyErr.message}`,
          );
        }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
