import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { AGENT_SUGGESTED_BY } from "@/lib/agent-loop/constants";
import { readOpportunityHeadline } from "@/lib/agent-loop/headline";
import { normalizeAgentSourcePost } from "@/lib/agent-loop/source-post-card";
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
  rollingWindowWeekStarts,
  withinRollingWindow,
} from "@/lib/agent-loop/week-plan";
import {
  createStoredWeekPlan,
  findLegacyGenericDraftId,
  loadStoredWeekPlan,
  mutateStoredWeekPlanItem,
  restoreLegacyDismissedOpportunityItems,
  type StoredWeekPlan,
} from "@/lib/agent-loop/week-plan-store";
import { SWIPE_POST_COLS } from "@/lib/swipe-query";

export const runtime = "nodejs";

const MAX_LEAD_MAGNET_DAYS = 2;
const OPPORTUNITY_POOL_LIMIT = 10;

async function composeFreshPlan(
  db: SupabaseClient,
  workspaceId: string,
  currentWeek: string,
): Promise<StoredWeekPlan> {
  const { data: opportunities, error: opportunityError } = await db
    .from("agent_opportunities")
    .select("id, payload, source_post_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "proposed")
    .order("score", { ascending: false })
    .limit(OPPORTUNITY_POOL_LIMIT);
  if (opportunityError) throw opportunityError;

  const sourcePostIds = opportunitySourcePostIds(opportunities);
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

  const opportunityById = new Map(
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
          isLeadMagnet: opportunityIsLeadMagnet(
            opportunity,
            leadMagnetPostIdSet,
          ),
          authorAvatar: sourcePostId
            ? (avatarByPostId.get(sourcePostId) ?? null)
            : null,
          sourcePostId,
        },
      ] as const;
    }),
  );
  const slots = composeWeekPlan({
    opportunities: (opportunities ?? []).map((opportunity) => ({
      id: opportunity.id as string,
      isLeadMagnet: opportunityIsLeadMagnet(
        opportunity,
        leadMagnetPostIdSet,
      ),
    })),
    days: 7,
    maxLeadMagnets: MAX_LEAD_MAGNET_DAYS,
    minGenericDays: 2,
    seed: Math.floor(Date.parse(currentWeek) / (1000 * 60 * 60 * 24)),
  });
  const days = workWeekDays(new Date(`${currentWeek}T00:00:00.000Z`));

  return {
    version: 1,
    weekStart: currentWeek,
    items: slots.map((slot, index) => {
      const day = days[index];
      const base = {
        id: randomUUID(),
        day: day.day,
        date: day.date,
        prompt: slot.kind === "generic" ? slot.prompt : null,
        userContext: null,
        selectedLeadMagnetId: null,
        status: "planned" as const,
        draftId: null,
      };
      if (slot.kind === "generic") {
        return { ...base, kind: "generic" as const };
      }
      const opportunity = opportunityById.get(slot.id);
      return {
        ...base,
        kind: "opportunity" as const,
        opportunity: {
          id: opportunity?.id ?? slot.id,
          headline: opportunity?.headline ?? "New opportunity",
          is_lead_magnet: opportunity?.isLeadMagnet ?? false,
          author_avatar: opportunity?.authorAvatar ?? null,
          source_post_id: opportunity?.sourcePostId ?? null,
        },
      };
    }),
  };
}

async function postingGap(
  db: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("chat_artifacts")
    .select("published_at, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return postingGapNote(
    daysSince(
      (data?.published_at as string | null) ??
        (data?.created_at as string | null) ??
        null,
    ),
  );
}

async function recoverLegacyDraftIds(
  db: SupabaseClient,
  workspaceId: string,
  currentWeek: string,
  plan: StoredWeekPlan,
): Promise<StoredWeekPlan> {
  const missing = plan.items.filter(
    (item) => item.status === "drafted" && !item.draftId,
  );
  if (missing.length === 0) return plan;

  const recovered = new Map<string, string>();
  const opportunityItems = missing.filter(
    (item) => item.kind === "opportunity" && item.opportunity?.id,
  );
  if (opportunityItems.length > 0) {
    const opportunityIds = opportunityItems.flatMap((item) =>
      item.opportunity?.id ? [item.opportunity.id] : [],
    );
    const { data, error } = await db
      .from("agent_opportunities")
      .select("id, drafted_artifact_id")
      .eq("workspace_id", workspaceId)
      .in("id", opportunityIds);
    if (!error) {
      const draftByOpportunity = new Map(
        (data ?? []).flatMap((row) =>
          typeof row.id === "string" &&
          typeof row.drafted_artifact_id === "string"
            ? [[row.id, row.drafted_artifact_id] as const]
            : [],
        ),
      );
      for (const item of opportunityItems) {
        const draftId = item.opportunity?.id
          ? draftByOpportunity.get(item.opportunity.id)
          : null;
        if (draftId) recovered.set(item.id, draftId);
      }
    }
  }

  const genericItems = missing.filter((item) => item.kind === "generic");
  if (genericItems.length > 0) {
    const [{ data: messages, error: messagesError }, { data: drafts, error: draftsError }] =
      await Promise.all([
        db
          .from("chat_messages")
          .select("chat_id, content, created_at")
          .eq("workspace_id", workspaceId)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .limit(200),
        db
          .from("chat_artifacts")
          .select("id, chat_id, created_at, meta")
          .eq("workspace_id", workspaceId)
          .eq("meta->>suggested_by", AGENT_SUGGESTED_BY)
          .order("created_at", { ascending: false })
          .limit(100),
      ]);
    if (!messagesError && !draftsError) {
      for (const item of genericItems) {
        const draftId = findLegacyGenericDraftId(
          item,
          messages ?? [],
          drafts ?? [],
        );
        if (draftId) recovered.set(item.id, draftId);
      }
    }
  }

  if (recovered.size === 0) return plan;
  const hydrated: StoredWeekPlan = {
    ...plan,
    items: plan.items.map((item) => ({
      ...item,
      draftId: recovered.get(item.id) ?? item.draftId ?? null,
    })),
  };
  await Promise.all(
    [...recovered].map(async ([itemId, draftId]) => {
      try {
        await mutateStoredWeekPlanItem(
          db,
          workspaceId,
          currentWeek,
          itemId,
          (item) =>
            item.status === "drafted" && !item.draftId
              ? { ...item, draftId }
              : null,
        );
      } catch (error) {
        console.error("agent_week_plan_draft_link_recovery_failed", {
          workspace_id: workspaceId,
          item_id: itemId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  return hydrated;
}

async function attachSourcePosts(
  db: SupabaseClient,
  workspaceId: string,
  plan: StoredWeekPlan,
) {
  const opportunityItems = plan.items.filter(
    (item) => item.kind === "opportunity" && item.opportunity,
  );
  if (opportunityItems.length === 0) return plan.items;

  const sourceIdByOpportunity = new Map<string, string>();
  const unresolvedOpportunityIds: string[] = [];
  for (const item of opportunityItems) {
    const opportunityId = item.opportunity?.id;
    const sourcePostId = item.opportunity?.source_post_id;
    if (!opportunityId) continue;
    if (sourcePostId) sourceIdByOpportunity.set(opportunityId, sourcePostId);
    else unresolvedOpportunityIds.push(opportunityId);
  }

  if (unresolvedOpportunityIds.length > 0) {
    const { data, error } = await db
      .from("agent_opportunities")
      .select("id, source_post_id")
      .eq("workspace_id", workspaceId)
      .in("id", unresolvedOpportunityIds);
    if (error) {
      console.error("agent_week_plan_source_lookup_failed", {
        workspace_id: workspaceId,
        message: error.message,
      });
    } else {
      for (const row of data ?? []) {
        if (
          typeof row.id === "string" &&
          typeof row.source_post_id === "string"
        ) {
          sourceIdByOpportunity.set(row.id, row.source_post_id);
        }
      }
    }
  }

  const sourcePostIds = [...new Set(sourceIdByOpportunity.values())];
  if (sourcePostIds.length === 0) return plan.items;
  const { data: sourceRows, error: sourceError } = await db
    .from("posts")
    .select(SWIPE_POST_COLS)
    .in("id", sourcePostIds);
  if (sourceError) {
    console.error("agent_week_plan_source_posts_failed", {
      workspace_id: workspaceId,
      message: sourceError.message,
    });
    return plan.items;
  }
  const sourceById = new Map(
    (sourceRows ?? []).flatMap((row) => {
      const sourcePost = normalizeAgentSourcePost(row);
      return sourcePost ? [[sourcePost.id, sourcePost] as const] : [];
    }),
  );

  return plan.items.map((item) => {
    const opportunityId = item.opportunity?.id;
    const sourcePostId = opportunityId
      ? sourceIdByOpportunity.get(opportunityId)
      : null;
    return item.opportunity
      ? {
          ...item,
          opportunity: {
            ...item.opportunity,
            source_post: sourcePostId
              ? (sourceById.get(sourcePostId) ?? null)
              : null,
          },
        }
      : item;
  });
}

// Uses the long-lived workspace settings store rather than a just-deployed
// table/RPC. That keeps the cadence compatible with the repo's manual migration
// process: the week remains visible and durable during rolling deployments.
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const currentWeek = weekStart();
    let plan: StoredWeekPlan | null = null;
    try {
      plan = await loadStoredWeekPlan(sb.raw, sb.workspaceId, currentWeek);
    } catch (error) {
      console.error("agent_week_plan_read_failed", {
        workspace_id: sb.workspaceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!plan) {
      plan = await composeFreshPlan(sb.raw, sb.workspaceId, currentWeek);
      plan = await createStoredWeekPlan(sb.raw, sb.workspaceId, plan);
    }
    plan = await restoreLegacyDismissedOpportunityItems(
      sb.raw,
      sb.workspaceId,
      currentWeek,
      plan,
    );
    plan = await recoverLegacyDraftIds(
      sb.raw,
      sb.workspaceId,
      currentWeek,
      plan,
    );
    // The cadence strip shows a ROLLING window (today + the next 6 days), while
    // plans are still STORED per calendar week. Six days out of seven that
    // window crosses a Monday boundary, so the tail lives in the NEXT week's
    // plan — which is COMPOSED ON DEMAND here if it doesn't exist yet, exactly
    // as the current week already is. Without that the last cards would simply
    // be missing, and a cadence with holes in it isn't a plan.
    //
    // This is cheap and safe to do per request: composeFreshPlan is pure DB
    // reads plus deterministic slotting — no LLM call — and createStoredWeekPlan
    // is a no-op when a plan already exists, so concurrent requests converge on
    // one row rather than racing to overwrite each other.
    const laterWeeks = rollingWindowWeekStarts().filter((w) => w !== currentWeek);
    const laterPlans = await Promise.all(
      laterWeeks.map(async (week) => {
        try {
          const existing = await loadStoredWeekPlan(sb.raw, sb.workspaceId, week);
          if (existing) return existing;
          const fresh = await composeFreshPlan(sb.raw, sb.workspaceId, week);
          return await createStoredWeekPlan(sb.raw, sb.workspaceId, fresh);
        } catch (error) {
          // Never fail the whole cadence because the NEXT week couldn't be
          // built — the visible days from this week still render.
          console.error("agent_week_plan_next_week_failed", {
            workspace_id: sb.workspaceId,
            week,
            message: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    );
    const windowPlan: StoredWeekPlan = {
      ...plan,
      items: withinRollingWindow([
        ...plan.items,
        ...laterPlans.flatMap((p) => p?.items ?? []),
      ]),
    };
    const [items, gapNote] = await Promise.all([
      attachSourcePosts(sb.raw, sb.workspaceId, windowPlan),
      postingGap(sb.raw, sb.workspaceId),
    ]);
    return NextResponse.json({
      ok: true,
      gapNote,
      items,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
