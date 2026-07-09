import { NextResponse } from "next/server";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
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
      return NextResponse.json({ ok: false, error: (r1.error || r2.error)!.message }, { status: 500 });
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
        return NextResponse.json(
          { ok: false, error: (upTrue.error || upFalse.error)!.message },
          { status: 500 },
        );
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
