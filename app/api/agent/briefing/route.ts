import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { AGENT_SUGGESTED_BY } from "@/lib/agent-loop/constants";
import { readOpportunityHeadline } from "@/lib/agent-loop/headline";
import {
  leadMagnetPostIds,
  opportunityIsLeadMagnet,
  opportunitySourcePostIds,
} from "@/lib/agent-loop/opportunity-post-type";
import {
  composeWorkingNowMix,
  WORKING_NOW_POOL_LIMIT,
} from "@/lib/agent-loop/working-now-mix";
import { normalizeAgentSourcePost } from "@/lib/agent-loop/source-post-card";
import { SWIPE_POST_COLS } from "@/lib/swipe-query";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/agent/briefing — the "While you were away" payload (Phase E1):
// drafts the agent wrote that are still unreviewed (idea/drafting) + the
// currently proposed opportunities. Read-only; the UI hides the section when
// both lists are empty.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();

    const [draftResult, opportunityResult] = await Promise.all([
      sb.raw
        .from("chat_artifacts")
        .select("id, title, body, kind, status, created_at, meta")
        .eq("workspace_id", sb.workspaceId)
        .eq("meta->>suggested_by", AGENT_SUGGESTED_BY)
        // Reviewed drafts stay off the list across reloads (POST
        // /api/agent/briefing/reviewed stamps meta.reviewed_at on Review click).
        .is("meta->>reviewed_at", null)
        .in("status", ["idea", "drafting"])
        .order("created_at", { ascending: false })
        .limit(5),
      // Fetch a scored POOL (not just the final slots) so we can compose a
      // healthy content mix from the top candidates.
      sb.raw
        .from("agent_opportunities")
        .select("id, kind, score, payload, created_at, source_post_id")
        .eq("workspace_id", sb.workspaceId)
        .eq("status", "proposed")
        .order("score", { ascending: false })
        .limit(WORKING_NOW_POOL_LIMIT),
    ]);
    const { data: drafts, error: draftsError } = draftResult;
    if (draftsError) throw draftsError;

    const { data: opportunityPool, error: oppError } = opportunityResult;
    if (oppError) throw oppError;

    // Which of these model a LEAD MAGNET post? `posts.post_type` is the
    // authoritative flag (stamped at scrape time, also what act.ts reads), and
    // agent_opportunities only carries source_post_id — so resolve it here for
    // the whole pool (needed to compose the mix). One small IN query.
    //
    // Two-step on purpose: the pool only needs existence + post_type (no join,
    // no long post text), while the FULL source-post card (SWIPE_POST_COLS +
    // the accounts join) is fetched only for the handful of slots the mix
    // actually keeps — the pool is ~4× the visible set.
    const sourcePostIds = opportunitySourcePostIds(opportunityPool);
    let leadMagnetIds = new Set<string>();
    const existingSourceIds = new Set<string>();
    if (sourcePostIds.length > 0) {
      const { data: postTypes, error: postTypesError } = await sb.raw
        .from("posts")
        .select("id, post_type")
        .in("id", sourcePostIds);
      if (postTypesError) throw postTypesError;
      leadMagnetIds = leadMagnetPostIds(postTypes);
      for (const row of postTypes ?? []) {
        if (typeof row?.id === "string") existingSourceIds.add(row.id);
      }
    }

    // payload.headline is persisted at scan time, so rows written before the
    // headline copy changed still carry the old "<creator> went N×" wording
    // (see lib/agent-loop/headline.ts). Normalise on the way out.
    const normalisedPool = (opportunityPool ?? []).map((opportunity) => {
      const payload = (opportunity.payload ?? {}) as Record<string, unknown>;
      const sourcePostId =
        typeof opportunity.source_post_id === "string"
          ? opportunity.source_post_id
          : null;
      return {
        ...opportunity,
        payload: { ...payload, headline: readOpportunityHeadline(payload) },
        is_lead_magnet: opportunityIsLeadMagnet(opportunity, leadMagnetIds),
        source_post: sourcePostId,
      };
    }).filter(
      (opportunity) =>
        opportunity.source_post !== null &&
        existingSourceIds.has(opportunity.source_post),
    );

    // Compose the visible slots as a healthy content mix (2 regular + 1 lead
    // magnet by default), backfilling from either type when the bank is thin.
    // The pool is already score-sorted, so the mixer keeps the strongest of
    // each type. Falls back to plain top-N behaviour when the pool has one type.
    const mixed = composeWorkingNowMix(normalisedPool);

    // Attach the complete source-post card only for the slots the mix kept.
    const mixedSourceIds = opportunitySourcePostIds(
      mixed.map((opportunity) => ({ source_post_id: opportunity.source_post })),
    );
    const sourcePostById = new Map<
      string,
      NonNullable<ReturnType<typeof normalizeAgentSourcePost>>
    >();
    if (mixedSourceIds.length > 0) {
      const { data: sourcePosts, error: sourcePostsError } = await sb.raw
        .from("posts")
        .select(SWIPE_POST_COLS)
        .in("id", mixedSourceIds);
      if (sourcePostsError) throw sourcePostsError;
      for (const post of sourcePosts ?? []) {
        const normalized = normalizeAgentSourcePost(post);
        if (normalized) {
          sourcePostById.set(normalized.id, normalized);
        }
      }
    }
    const normalisedOpportunities = mixed
      .map((opportunity) => ({
        ...opportunity,
        source_post: opportunity.source_post
          ? (sourcePostById.get(opportunity.source_post) ?? null)
          : null,
      }))
      .filter((opportunity) => opportunity.source_post !== null);

    return NextResponse.json({
      ok: true,
      drafts: drafts ?? [],
      opportunities: normalisedOpportunities,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
