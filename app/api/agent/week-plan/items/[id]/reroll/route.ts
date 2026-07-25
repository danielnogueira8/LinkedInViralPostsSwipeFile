import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { readOpportunityHeadline } from "@/lib/agent-loop/headline";
import {
  leadMagnetPostIds,
  opportunityIsLeadMagnet,
} from "@/lib/agent-loop/opportunity-post-type";
import {
  pickNextGenericPrompt,
  weekStart,
  rollingWindowWeekStarts,
} from "@/lib/agent-loop/week-plan";
import {
  loadStoredWeekPlan,
  mutateStoredWeekPlanItemAcross,
  type StoredWeekPlanItem,
} from "@/lib/agent-loop/week-plan-store";

export const runtime = "nodejs";

const OPPORTUNITY_POOL_LIMIT = 20;

type OpportunityCandidate = {
  id: string;
  headline: string;
  isLeadMagnet: boolean;
  authorAvatar: string | null;
  sourcePostId: string | null;
};

/** Every opportunity already showing on this week's plan, so a reroll never
 *  just duplicates a sibling card (or re-picks the slot's own opportunity). */
function usedOpportunityIds(items: readonly StoredWeekPlanItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.opportunity?.id) ids.add(item.opportunity.id);
  }
  return ids;
}

async function findOpportunityCandidate(
  db: SupabaseClient,
  workspaceId: string,
  wantLeadMagnet: boolean,
  excludeIds: ReadonlySet<string>,
): Promise<OpportunityCandidate | null> {
  const { data: opportunities, error } = await db
    .from("agent_opportunities")
    .select("id, payload, source_post_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "proposed")
    .order("score", { ascending: false })
    .limit(OPPORTUNITY_POOL_LIMIT);
  if (error) throw error;

  const pool = (opportunities ?? []).filter(
    (row) => typeof row.id === "string" && !excludeIds.has(row.id),
  );
  if (pool.length === 0) return null;

  const sourcePostIds = [
    ...new Set(
      pool.flatMap((row) =>
        typeof row.source_post_id === "string" ? [row.source_post_id] : [],
      ),
    ),
  ];
  let leadMagnetPostIdSet = new Set<string>();
  const avatarByPostId = new Map<string, string>();
  if (sourcePostIds.length > 0) {
    const { data: sourcePosts, error: sourcePostError } = await db
      .from("posts")
      .select("id, post_type, accounts(profile_pic_url)")
      .in("id", sourcePostIds);
    if (sourcePostError) throw sourcePostError;
    leadMagnetPostIdSet = leadMagnetPostIds(sourcePosts);
    for (const post of sourcePosts ?? []) {
      const account = Array.isArray(post.accounts)
        ? post.accounts[0]
        : post.accounts;
      if (
        typeof post.id === "string" &&
        typeof account?.profile_pic_url === "string" &&
        account.profile_pic_url
      ) {
        avatarByPostId.set(post.id, account.profile_pic_url);
      }
    }
  }

  const match = pool.find(
    (row) =>
      opportunityIsLeadMagnet(row, leadMagnetPostIdSet) === wantLeadMagnet,
  );
  if (!match) return null;

  const payload = (match.payload ?? {}) as Record<string, unknown>;
  const sourcePostId =
    typeof match.source_post_id === "string" ? match.source_post_id : null;
  return {
    id: match.id as string,
    headline: readOpportunityHeadline(payload),
    isLeadMagnet: wantLeadMagnet,
    authorAvatar: sourcePostId
      ? (avatarByPostId.get(sourcePostId) ?? null)
      : null,
    sourcePostId,
  };
}

// -----------------------------------------------------------------------------
// POST /api/agent/week-plan/items/[id]/reroll — swap a planned cadence card
// for a different one of the same kind: another opportunity of the same
// lead-magnet/regular type, or another generic story prompt. Drafted/
// dismissed cards can't be rerolled — only "planned" slots are still up for
// grabs.
// -----------------------------------------------------------------------------
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const currentWeek = weekStart();

    const plan = await loadStoredWeekPlan(sb.raw, sb.workspaceId, currentWeek);
    const current = plan?.items.find((item) => item.id === id) ?? null;
    if (!current || current.status !== "planned") {
      return NextResponse.json(
        { ok: false, error: "This card is no longer available to refresh." },
        { status: 409 },
      );
    }

    let candidate: OpportunityCandidate | null = null;
    let nextPrompt: string | null = null;
    if (current.kind === "opportunity") {
      candidate = await findOpportunityCandidate(
        sb.raw,
        sb.workspaceId,
        current.opportunity?.is_lead_magnet === true,
        usedOpportunityIds(plan!.items),
      );
      if (!candidate) {
        return NextResponse.json(
          {
            ok: false,
            error: current.opportunity?.is_lead_magnet
              ? "No other lead magnet source is available right now."
              : "No other source post is available right now.",
          },
          { status: 404 },
        );
      }
    } else {
      nextPrompt = pickNextGenericPrompt({
        current: current.prompt ?? "",
        usedPrompts: plan!.items
          .filter((item) => item.kind === "generic" && item.prompt)
          .map((item) => item.prompt as string),
      });
      if (!nextPrompt) {
        return NextResponse.json(
          { ok: false, error: "No other idea is available right now." },
          { status: 404 },
        );
      }
    }

    // Search every week the rolling window spans: a visible card can belong to
    // next week's stored plan, and resolving against currentWeek alone made
    // those reroll clicks silently no-op.
    const updated = await mutateStoredWeekPlanItemAcross(
      sb.raw,
      sb.workspaceId,
      rollingWindowWeekStarts(),
      id,
      (item) => {
        if (item.status !== "planned") return null;
        if (item.kind === "opportunity" && candidate) {
          return {
            ...item,
            userContext: null,
            selectedLeadMagnetId: null,
            opportunity: {
              id: candidate.id,
              headline: candidate.headline,
              is_lead_magnet: candidate.isLeadMagnet,
              author_avatar: candidate.authorAvatar,
              source_post_id: candidate.sourcePostId,
            },
          };
        }
        if (item.kind === "generic" && nextPrompt) {
          return { ...item, prompt: nextPrompt, userContext: null };
        }
        return null;
      },
    );
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "This card is no longer available to refresh." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
