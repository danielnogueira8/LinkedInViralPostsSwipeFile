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

    const { data: drafts, error: draftsError } = await sb.raw
      .from("chat_artifacts")
      .select("id, title, body, kind, status, created_at, meta")
      .eq("workspace_id", sb.workspaceId)
      .eq("meta->>suggested_by", AGENT_SUGGESTED_BY)
      // Reviewed drafts stay off the list across reloads (POST
      // /api/agent/briefing/reviewed stamps meta.reviewed_at on Review click).
      .is("meta->>reviewed_at", null)
      .in("status", ["idea", "drafting"])
      .order("created_at", { ascending: false })
      .limit(5);
    if (draftsError) throw draftsError;

    const { data: opportunities, error: oppError } = await sb.raw
      .from("agent_opportunities")
      .select("id, kind, score, payload, created_at, source_post_id")
      .eq("workspace_id", sb.workspaceId)
      .eq("status", "proposed")
      .order("score", { ascending: false })
      .limit(3);
    if (oppError) throw oppError;

    // Which of these model a LEAD MAGNET post? `posts.post_type` is the
    // authoritative flag (stamped at scrape time, also what act.ts reads), and
    // agent_opportunities only carries source_post_id — so resolve it here.
    // At most 3 opportunities, so this is a single small IN query.
    const sourcePostIds = opportunitySourcePostIds(opportunities);
    let leadMagnetIds = new Set<string>();
    if (sourcePostIds.length > 0) {
      const { data: sourcePosts, error: sourcePostsError } = await sb.raw
        .from("posts")
        .select("id, post_type")
        .in("id", sourcePostIds);
      if (sourcePostsError) throw sourcePostsError;
      leadMagnetIds = leadMagnetPostIds(sourcePosts);
    }

    // payload.headline is persisted at scan time, so rows written before the
    // headline copy changed still carry the old "<creator> went N×" wording
    // (see lib/agent-loop/headline.ts). Normalise on the way out.
    const normalisedOpportunities = (opportunities ?? []).map((opportunity) => {
      const payload = (opportunity.payload ?? {}) as Record<string, unknown>;
      return {
        ...opportunity,
        payload: { ...payload, headline: readOpportunityHeadline(payload) },
        is_lead_magnet: opportunityIsLeadMagnet(opportunity, leadMagnetIds),
      };
    });

    return NextResponse.json({
      ok: true,
      drafts: drafts ?? [],
      opportunities: normalisedOpportunities,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
