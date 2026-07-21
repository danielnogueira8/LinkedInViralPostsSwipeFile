import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { readOpportunityHeadline } from "@/lib/agent-loop/headline";
import {
  leadMagnetPostIds,
  opportunityIsLeadMagnet,
  opportunitySourcePostIds,
} from "@/lib/agent-loop/opportunity-post-type";
import {
  daysSince,
  nextWeekdays,
  postingGapNote,
} from "@/lib/agent-loop/week-plan";

export const runtime = "nodejs";

const PLAN_ITEMS = 5;

// -----------------------------------------------------------------------------
// GET /api/agent/week-plan — Plan-my-week (Phase F). EPHEMERAL: builds a fresh
// plan from this moment's signals on every call (top proposed opportunities +
// posting gap). No tables, no cron — re-clicking regenerates from live data.
// Each item carries the opportunity id so "Draft this" can reuse the normal
// grounded-turn action (POST /api/agent/opportunities/[id]).
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();

    const { data: opportunities, error: oppError } = await sb.raw
      .from("agent_opportunities")
      .select("id, kind, score, payload, created_at, source_post_id")
      .eq("workspace_id", sb.workspaceId)
      .eq("status", "proposed")
      .order("score", { ascending: false })
      .limit(PLAN_ITEMS);
    if (oppError) throw oppError;

    const sourcePostIds = opportunitySourcePostIds(opportunities);
    let leadMagnetIds = new Set<string>();
    const avatarByPostId = new Map<string, string>();
    if (sourcePostIds.length > 0) {
      const { data: sourcePosts, error: sourcePostsError } = await sb.raw
        .from("posts")
        .select("id, post_type, accounts(profile_pic_url)")
        .in("id", sourcePostIds);
      if (sourcePostsError) throw sourcePostsError;
      leadMagnetIds = leadMagnetPostIds(sourcePosts);
      for (const post of sourcePosts ?? []) {
        const acc = Array.isArray(post.accounts)
          ? post.accounts[0]
          : post.accounts;
        const url = acc?.profile_pic_url;
        if (typeof post.id === "string" && typeof url === "string" && url) {
          avatarByPostId.set(post.id, url);
        }
      }
    }

    // Posting gap: days since the user's last PUBLISHED post.
    const { data: lastPosted, error: lastPostedError } = await sb.raw
      .from("chat_artifacts")
      .select("published_at, created_at")
      .eq("workspace_id", sb.workspaceId)
      .eq("status", "posted")
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (lastPostedError) throw lastPostedError;
    const quietDays = daysSince(
      (lastPosted?.published_at as string | null) ??
        (lastPosted?.created_at as string | null) ??
        null,
    );

    const dayLabels = nextWeekdays((opportunities ?? []).length);
    const items = (opportunities ?? []).map((opportunity, index) => {
      const payload = (opportunity.payload ?? {}) as Record<string, unknown>;
      const sourcePostId =
        typeof opportunity.source_post_id === "string"
          ? opportunity.source_post_id
          : null;
      return {
        day: dayLabels[index] ?? `Day ${index + 1}`,
        opportunity: {
          id: opportunity.id as string,
          headline: readOpportunityHeadline(payload),
          is_lead_magnet: opportunityIsLeadMagnet(opportunity, leadMagnetIds),
          author_avatar: sourcePostId
            ? (avatarByPostId.get(sourcePostId) ?? null)
            : null,
        },
      };
    });

    return NextResponse.json({
      ok: true,
      daysSinceLastPost: quietDays,
      gapNote: postingGapNote(quietDays),
      items,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
