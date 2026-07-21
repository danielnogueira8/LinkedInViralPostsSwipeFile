import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { AGENT_SUGGESTED_BY } from "@/lib/agent-loop/constants";
import { readOpportunityHeadline } from "@/lib/agent-loop/headline";

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
      .in("status", ["idea", "drafting"])
      .order("created_at", { ascending: false })
      .limit(5);
    if (draftsError) throw draftsError;

    const { data: opportunities, error: oppError } = await sb.raw
      .from("agent_opportunities")
      .select("id, kind, score, payload, created_at")
      .eq("workspace_id", sb.workspaceId)
      .eq("status", "proposed")
      .order("score", { ascending: false })
      .limit(3);
    if (oppError) throw oppError;

    // payload.headline is persisted at scan time, so rows written before the
    // headline copy changed still carry the old "<creator> went N×" wording
    // (see lib/agent-loop/headline.ts). Normalise on the way out.
    const normalisedOpportunities = (opportunities ?? []).map((opportunity) => {
      const payload = (opportunity.payload ?? {}) as Record<string, unknown>;
      return {
        ...opportunity,
        payload: { ...payload, headline: readOpportunityHeadline(payload) },
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
