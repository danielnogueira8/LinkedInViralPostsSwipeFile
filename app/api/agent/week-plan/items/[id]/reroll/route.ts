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
  GENERIC_WEEK_PROMPTS,
  pickNextGenericPrompt,
  weekStart,
  rollingWindowWeekStarts,
} from "@/lib/agent-loop/week-plan";
import {
  rankGenericWeekPrompts,
  rankWeekPlanOpportunities,
  type WeekPlanLearningSource,
  weekPlanLearningSource,
} from "@/lib/agent-loop/week-plan-learning";
import {
  loadStoredWeekPlan,
  mutateStoredWeekPlanItemAcross,
  type StoredWeekPlanItem,
} from "@/lib/agent-loop/week-plan-store";
import { loadActiveWorkspaceLearning } from "@/lib/content-learning/workspace-learning-context";
import type { WorkspaceLearningModel } from "@/lib/content-learning/contracts";

export const runtime = "nodejs";

const OPPORTUNITY_POOL_LIMIT = 20;

type OpportunityCandidate = {
  id: string;
  headline: string;
  isLeadMagnet: boolean;
  authorAvatar: string | null;
  sourcePostId: string | null;
  sourceText: string;
  learningSource: WeekPlanLearningSource | null;
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
  learning: WorkspaceLearningModel | null,
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
  const textByPostId = new Map<string, string>();
  if (sourcePostIds.length > 0) {
    const { data: sourcePosts, error: sourcePostError } = await db
      .from("posts")
      .select("id, text, post_type, accounts(profile_pic_url)")
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
      if (
        typeof post.id === "string" &&
        typeof post.text === "string"
      ) {
        textByPostId.set(post.id, post.text);
      }
    }
  }

  const candidates = pool
    .filter(
      (row) =>
        opportunityIsLeadMagnet(row, leadMagnetPostIdSet) === wantLeadMagnet,
    )
    .map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const sourcePostId =
        typeof row.source_post_id === "string"
          ? row.source_post_id
          : null;
      const sourceText = sourcePostId
        ? (textByPostId.get(sourcePostId) ?? "")
        : "";
      return {
        id: row.id as string,
        headline: readOpportunityHeadline(payload),
        isLeadMagnet: wantLeadMagnet,
        authorAvatar: sourcePostId
          ? (avatarByPostId.get(sourcePostId) ?? null)
          : null,
        sourcePostId,
        sourceText,
        learningSource: weekPlanLearningSource(sourceText, learning),
      };
    });
  const match = rankWeekPlanOpportunities(
    candidates,
    learning,
    { preserveStrongest: false },
  )[0];
  if (!match) return null;
  return match;
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
    const learning = await loadActiveWorkspaceLearning(
      sb.raw,
      sb.workspaceId,
    );

    let candidate: OpportunityCandidate | null = null;
    let nextPrompt: string | null = null;
    if (current.kind === "opportunity") {
      candidate = await findOpportunityCandidate(
        sb.raw,
        sb.workspaceId,
        current.opportunity?.is_lead_magnet === true,
        usedOpportunityIds(plan!.items),
        learning,
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
        prompts: rankGenericWeekPrompts(
          GENERIC_WEEK_PROMPTS,
          learning,
        ),
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
            learningSource: candidate.learningSource,
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
          return {
            ...item,
            prompt: nextPrompt,
            userContext: null,
            learningSource: weekPlanLearningSource(
              nextPrompt,
              learning,
            ),
          };
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
