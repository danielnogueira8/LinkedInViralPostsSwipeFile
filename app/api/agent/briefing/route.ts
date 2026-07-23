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
    // the whole pool (needed to compose the mix). One small IN query. The same
    // read also grabs the complete source-post shape used by the Swipe File
    // card, so users can inspect the original before asking the agent to model
    // it. This remains one batched IN query for the entire opportunity pool.
    const sourcePostIds = opportunitySourcePostIds(opportunityPool);
    let leadMagnetIds = new Set<string>();
    const sourcePostById = new Map<
      string,
      NonNullable<ReturnType<typeof normalizeAgentSourcePost>>
    >();
    if (sourcePostIds.length > 0) {
      const { data: sourcePosts, error: sourcePostsError } = await sb.raw
        .from("posts")
        .select(SWIPE_POST_COLS)
        .in("id", sourcePostIds);
      if (sourcePostsError) throw sourcePostsError;
      leadMagnetIds = leadMagnetPostIds(sourcePosts);
      for (const post of sourcePosts ?? []) {
        const normalized = normalizeAgentSourcePost(post);
        if (normalized) {
          sourcePostById.set(normalized.id, normalized);
        }
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
        source_post: sourcePostId
          ? (sourcePostById.get(sourcePostId) ?? null)
          : null,
      };
    }).filter((opportunity) => opportunity.source_post !== null);

    // Compose the visible slots as a healthy content mix (2 regular + 1 lead
    // magnet by default), backfilling from either type when the bank is thin.
    // The pool is already score-sorted, so the mixer keeps the strongest of
    // each type. Falls back to plain top-N behaviour when the pool has one type.
    const normalisedOpportunities = composeWorkingNowMix(normalisedPool);

    return NextResponse.json({
      ok: true,
      drafts: drafts ?? [],
      opportunities: normalisedOpportunities,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
