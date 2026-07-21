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
  composeWeekPlan,
  daysSince,
  nextDays,
  postingGapNote,
} from "@/lib/agent-loop/week-plan";

export const runtime = "nodejs";

const PLAN_DAYS = 7;
const MAX_LEAD_MAGNET_DAYS = 2;
const OPPORTUNITY_POOL_LIMIT = 10;

// -----------------------------------------------------------------------------
// GET /api/agent/week-plan — Plan-my-week (Phase F). EPHEMERAL: builds a fresh
// 7-day plan (weekends included) from this moment's signals on every call. The
// week mixes opportunity days (top proposals, max 2 lead magnets) with generic
// "your story" days (curated prompts the agent can't source). No tables, no
// cron — re-clicking regenerates from live data with a day-seeded rotation.
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
      .limit(OPPORTUNITY_POOL_LIMIT);
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

    // Compose the week: opportunities first (score order, lead magnets capped
    // at MAX_LEAD_MAGNET_DAYS), generic "your story" prompts filling the rest.
    // Day-of-year seeds the generic rotation so tomorrow's plan differs from
    // today's without any randomness to reproduce.
    const byId = new Map(
      (opportunities ?? []).map((opportunity) => {
        const payload = (opportunity.payload ?? {}) as Record<string, unknown>;
        const sourcePostId =
          typeof opportunity.source_post_id === "string"
            ? opportunity.source_post_id
            : null;
        return [
          opportunity.id as string,
          {
            id: opportunity.id as string,
            headline: readOpportunityHeadline(payload),
            is_lead_magnet: opportunityIsLeadMagnet(opportunity, leadMagnetIds),
            author_avatar: sourcePostId
              ? (avatarByPostId.get(sourcePostId) ?? null)
              : null,
          },
        ] as const;
      }),
    );
    const dayOfYear = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
    const slots = composeWeekPlan({
      opportunities: (opportunities ?? []).map((opportunity) => ({
        id: opportunity.id as string,
        isLeadMagnet: opportunityIsLeadMagnet(opportunity, leadMagnetIds),
      })),
      days: PLAN_DAYS,
      maxLeadMagnets: MAX_LEAD_MAGNET_DAYS,
      minGenericDays: 2,
      seed: dayOfYear,
    });
    const dayLabels = nextDays(slots.length);
    const items = slots.map((slot, index) => {
      const day = dayLabels[index] ?? `Day ${index + 1}`;
      if (slot.kind === "generic") {
        return { day, kind: "generic" as const, prompt: slot.prompt };
      }
      return {
        day,
        kind: "opportunity" as const,
        opportunity: byId.get(slot.id) ?? { id: slot.id, headline: "New opportunity" },
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
