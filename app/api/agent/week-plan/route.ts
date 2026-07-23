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
  postingGapNote,
  weekStart,
  workWeekDays,
} from "@/lib/agent-loop/week-plan";

export const runtime = "nodejs";

const PLAN_DAYS = 7;
const MAX_LEAD_MAGNET_DAYS = 2;
const OPPORTUNITY_POOL_LIMIT = 10;

type StoredPlanItem = {
  id: string;
  planned_for: string;
  kind: "opportunity" | "generic";
  opportunity_id: string | null;
  prompt: string | null;
  headline: string | null;
  is_lead_magnet: boolean;
  author_avatar: string | null;
  user_context: string | null;
  status: "planned" | "drafting" | "drafted" | "dismissed";
};

function labelFor(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

function responseItems(items: StoredPlanItem[]) {
  return items.map((item) => ({
    id: item.id,
    day: labelFor(item.planned_for),
    date: item.planned_for,
    kind: item.kind,
    prompt: item.prompt,
    userContext: item.user_context,
    status: item.status,
    ...(item.kind === "opportunity"
      ? {
          opportunity: {
            id: item.opportunity_id,
            headline: item.headline ?? "New opportunity",
            is_lead_magnet: item.is_lead_magnet,
            author_avatar: item.author_avatar,
          },
        }
      : {}),
  }));
}

// GET /api/agent/week-plan — return the durable Monday–Sunday plan for the
// current workspace. We compose only when the workspace enters a new week;
// refreshing, drafting, and navigating never reshuffle the user's cards.
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const currentWeek = weekStart();
    const { data: existingPlan, error: existingPlanError } = await sb.raw
      .from("agent_week_plans")
      .select("id")
      .eq("workspace_id", sb.workspaceId)
      .eq("week_start", currentWeek)
      .maybeSingle();
    if (existingPlanError) throw existingPlanError;

    let planId = existingPlan?.id as string | undefined;
    if (!planId) {
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
          const account = Array.isArray(post.accounts)
            ? post.accounts[0]
            : post.accounts;
          const url = account?.profile_pic_url;
          if (typeof post.id === "string" && typeof url === "string" && url) {
            avatarByPostId.set(post.id, url);
          }
        }
      }

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
              isLeadMagnet: opportunityIsLeadMagnet(opportunity, leadMagnetIds),
              authorAvatar: sourcePostId
                ? (avatarByPostId.get(sourcePostId) ?? null)
                : null,
            },
          ] as const;
        }),
      );
      const slots = composeWeekPlan({
        opportunities: (opportunities ?? []).map((opportunity) => ({
          id: opportunity.id as string,
          isLeadMagnet: opportunityIsLeadMagnet(opportunity, leadMagnetIds),
        })),
        days: PLAN_DAYS,
        maxLeadMagnets: MAX_LEAD_MAGNET_DAYS,
        minGenericDays: 2,
        seed: Math.floor(Date.parse(currentWeek) / (1000 * 60 * 60 * 24)),
      });

      const days = workWeekDays(new Date(`${currentWeek}T00:00:00.000Z`));
      const rows = slots.map((slot, index) => {
        const day = days[index];
        if (slot.kind === "generic") {
          return {
            slot_index: index,
            planned_for: day.date,
            kind: "generic",
            prompt: slot.prompt,
          };
        }
        const opportunity = byId.get(slot.id);
        return {
          slot_index: index,
          planned_for: day.date,
          kind: "opportunity",
          opportunity_id: slot.id,
          headline: opportunity?.headline ?? "New opportunity",
          is_lead_magnet: opportunity?.isLeadMagnet ?? false,
          author_avatar: opportunity?.authorAvatar ?? null,
        };
      });
      // One database transaction creates both the parent and its cards. A
      // concurrent request receives the already-complete unique plan instead.
      const { data: createdPlanId, error: createPlanError } = await sb.raw.rpc(
        "create_agent_week_plan",
        {
          p_workspace_id: sb.workspaceId,
          p_week_start: currentWeek,
          p_items: rows,
        },
      );
      if (createPlanError || typeof createdPlanId !== "string") {
        throw createPlanError ?? new Error("Could not create this week's plan.");
      }
      planId = createdPlanId;
    }

    const { data: items, error: itemsError } = await sb.raw
      .from("agent_week_plan_items")
      .select("id, planned_for, kind, opportunity_id, prompt, headline, is_lead_magnet, author_avatar, user_context, status")
      .eq("workspace_id", sb.workspaceId)
      .eq("plan_id", planId)
      .order("slot_index", { ascending: true });
    if (itemsError) throw itemsError;

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

    return NextResponse.json({
      ok: true,
      daysSinceLastPost: quietDays,
      gapNote: postingGapNote(quietDays),
      items: responseItems((items ?? []) as StoredPlanItem[]),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
