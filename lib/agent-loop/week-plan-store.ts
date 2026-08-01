import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
const itemSchema = z.object({
  id: z.string().min(1),
  day: z.string().min(1),
  date: z.string().min(10),
  kind: z.enum(["opportunity", "generic"]),
  prompt: z.string().nullable(),
  userContext: z.string().nullable(),
  selectedLeadMagnetId: z.string().nullable(),
  learningSource: z
    .enum(["voice_exemplars", "published_posts"])
    .nullable()
    .optional(),
  status: z.enum(["planned", "drafting", "drafted", "dismissed"]),
  // Optional keeps plans saved before this field was introduced readable.
  draftId: z.string().uuid().nullable().optional(),
  // A hard-killed actor can leave a card in drafting. Optional keeps legacy
  // JSON plans readable; recovery uses the settings updated_at as a safe
  // rollout-era fallback when this field is missing.
  draftingStartedAt: z.string().datetime().nullable().optional(),
  opportunity: z
    .object({
      id: z.string().nullable(),
      headline: z.string(),
      is_lead_magnet: z.boolean(),
      author_avatar: z.string().nullable(),
      source_post_id: z.string().nullable().optional(),
    })
    .optional(),
});

const planSchema = z.object({
  version: z.literal(1),
  weekStart: z.string().min(10),
  items: z.array(itemSchema).length(7),
});

export type StoredWeekPlanItem = z.infer<typeof itemSchema>;
export type StoredWeekPlan = z.infer<typeof planSchema>;

export const WEEK_PLAN_DRAFT_LEASE_MS = 15 * 60 * 1000;

export function recoverStaleDraftingItems(
  plan: StoredWeekPlan,
  now = new Date(),
  leaseMs = WEEK_PLAN_DRAFT_LEASE_MS,
  legacyPlanUpdatedAt?: string,
): { plan: StoredWeekPlan; recovered: boolean } {
  const cutoff = now.getTime() - leaseMs;
  let recovered = false;
  const items = plan.items.map((item) => {
    if (item.status !== "drafting") return item;
    const startedAtValue = item.draftingStartedAt ?? legacyPlanUpdatedAt;
    if (!startedAtValue) return item;
    const startedAt = Date.parse(startedAtValue);
    if (!Number.isFinite(startedAt) || startedAt > cutoff) return item;
    recovered = true;
    return {
      ...item,
      status: "planned" as const,
      draftId: null,
      draftingStartedAt: null,
    };
  });
  return recovered ? { plan: { ...plan, items }, recovered } : { plan, recovered };
}

type LegacyWeekPlanMessage = {
  chat_id: string;
  content: string;
  created_at: string;
};

type LegacyWeekPlanDraft = {
  id: string;
  chat_id: string | null;
  created_at: string;
  meta: Record<string, unknown> | null;
};

/**
 * Plans saved before draftId was introduced can recover a generic cadence
 * draft from the exact chat turn that created it. The system user message
 * includes both the plan prompt and the user's context; the first agent draft
 * saved after that message (and before the next user turn) is its board draft.
 */
export function findLegacyGenericDraftId(
  item: Pick<StoredWeekPlanItem, "prompt" | "userContext">,
  messages: LegacyWeekPlanMessage[],
  drafts: LegacyWeekPlanDraft[],
): string | null {
  const prompt = item.prompt?.trim();
  if (!prompt) return null;
  const promptMarker = `Topic direction: ${prompt}.`;
  const contextMarker = item.userContext?.trim() ?? "";
  const matchingMessages = messages
    .filter(
      (message) =>
        message.content.includes(promptMarker) &&
        (!contextMarker || message.content.includes(contextMarker)),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  for (const message of matchingMessages) {
    const nextUserAt = messages
      .filter(
        (candidate) =>
          candidate.chat_id === message.chat_id &&
          candidate.created_at > message.created_at,
      )
      .map((candidate) => candidate.created_at)
      .sort()[0];
    const match = drafts
      .filter(
        (draft) =>
          draft.chat_id === message.chat_id &&
          draft.created_at >= message.created_at &&
          (!nextUserAt || draft.created_at < nextUserAt) &&
          !draft.meta?.agent_opportunity_id,
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (match) return match.id;
  }
  return null;
}

type StoredWeekPlanSnapshot = {
  plan: StoredWeekPlan;
  updatedAt: string;
};

export function weekPlanSettingKey(weekStart: string): string {
  return `agent_week_plan:${weekStart}`;
}

async function loadStoredWeekPlanSnapshot(
  db: SupabaseClient,
  workspaceId: string,
  weekStart: string,
): Promise<StoredWeekPlanSnapshot | null> {
  const { data, error } = await db
    .from("settings")
    .select("value, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("key", weekPlanSettingKey(weekStart))
    .maybeSingle();
  if (error) throw error;
  const parsed = planSchema.safeParse(data?.value);
  return parsed.success &&
    parsed.data.weekStart === weekStart &&
    typeof data?.updated_at === "string"
    ? { plan: parsed.data, updatedAt: data.updated_at }
    : null;
}

export async function loadStoredWeekPlan(
  db: SupabaseClient,
  workspaceId: string,
  weekStart: string,
): Promise<StoredWeekPlan | null> {
  return (
    (await loadStoredWeekPlanSnapshot(db, workspaceId, weekStart))?.plan ?? null
  );
}

export async function createStoredWeekPlan(
  db: SupabaseClient,
  workspaceId: string,
  plan: StoredWeekPlan,
): Promise<StoredWeekPlan> {
  const { error } = await db.from("settings").insert({
    workspace_id: workspaceId,
    key: weekPlanSettingKey(plan.weekStart),
    value: plan,
    updated_at: new Date().toISOString(),
  });
  if (!error) return plan;
  if (error.code !== "23505") throw error;

  const existing = await loadStoredWeekPlan(db, workspaceId, plan.weekStart);
  if (!existing) throw error;
  return existing;
}

async function mutateStoredWeekPlan(
  db: SupabaseClient,
  workspaceId: string,
  weekStart: string,
  mutate: (
    plan: StoredWeekPlan,
    updatedAt: string,
  ) => StoredWeekPlan | null,
): Promise<StoredWeekPlan | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await loadStoredWeekPlanSnapshot(
      db,
      workspaceId,
      weekStart,
    );
    if (!snapshot) return null;
    const updated = mutate(snapshot.plan, snapshot.updatedAt);
    if (!updated) return null;
    const nextUpdatedAt = new Date(
      Math.max(Date.now(), Date.parse(snapshot.updatedAt) + 1),
    ).toISOString();
    const { data, error } = await db
      .from("settings")
      .update({ value: updated, updated_at: nextUpdatedAt })
      .eq("workspace_id", workspaceId)
      .eq("key", weekPlanSettingKey(weekStart))
      .eq("updated_at", snapshot.updatedAt)
      .select("updated_at")
      .maybeSingle();
    if (error) throw error;
    if (data) return updated;
  }
  throw new Error("Weekly plan changed too quickly. Please try again.");
}

/**
 * Mutate an item that may live in EITHER week the rolling window spans.
 *
 * The cadence strip shows today + 6 days, which crosses a Monday boundary on
 * six days out of seven — so a visible card can belong to next week's stored
 * plan. Resolving mutations against the current week alone made those cards
 * silently no-op: the click succeeded, nothing changed, no error.
 *
 * Tries each candidate week in order and returns the first hit. Item ids are
 * UUIDs, so there is no chance of matching the wrong plan's item.
 */
export async function mutateStoredWeekPlanItemAcross(
  db: SupabaseClient,
  workspaceId: string,
  weekStarts: readonly string[],
  itemId: string,
  mutate: (item: StoredWeekPlanItem) => StoredWeekPlanItem | null,
): Promise<StoredWeekPlanItem | null> {
  for (const week of weekStarts) {
    const updated = await mutateStoredWeekPlanItem(
      db,
      workspaceId,
      week,
      itemId,
      mutate,
    );
    if (updated) return updated;
  }
  return null;
}

/**
 * Resolve a rolling-window card against the plan that currently owns it.
 * The client shows cards from two Monday-anchored plans near a week boundary,
 * so a current-week-only preflight can reject a perfectly valid visible card.
 */
export async function resolveStoredWeekPlanItemAcross(
  db: SupabaseClient,
  workspaceId: string,
  weekStarts: readonly string[],
  itemId: string,
): Promise<{
  weekStart: string;
  plan: StoredWeekPlan;
  item: StoredWeekPlanItem;
} | null> {
  for (const candidateWeek of weekStarts) {
    const plan = await loadStoredWeekPlan(db, workspaceId, candidateWeek);
    const item = plan?.items.find((candidate) => candidate.id === itemId);
    if (plan && item) {
      return { weekStart: candidateWeek, plan, item };
    }
  }
  return null;
}

export async function mutateStoredWeekPlanItem(
  db: SupabaseClient,
  workspaceId: string,
  weekStart: string,
  itemId: string,
  mutate: (item: StoredWeekPlanItem) => StoredWeekPlanItem | null,
): Promise<StoredWeekPlanItem | null> {
  let updatedItem: StoredWeekPlanItem | null = null;
  const plan = await mutateStoredWeekPlan(
    db,
    workspaceId,
    weekStart,
    (current) => {
      const index = current.items.findIndex((item) => item.id === itemId);
      if (index < 0) return null;
      updatedItem = mutate(current.items[index]);
      if (!updatedItem) return null;
      const items = [...current.items];
      items[index] = updatedItem;
      return { ...current, items };
    },
  );
  return plan ? updatedItem : null;
}

/** Persist stale-card recovery with the same optimistic settings lock used by
 * every other weekly-plan mutation. */
export async function recoverStaleWeekPlanDrafts(
  db: SupabaseClient,
  workspaceId: string,
  weekStart: string,
  plan: StoredWeekPlan,
  now = new Date(),
): Promise<StoredWeekPlan> {
  const snapshot = await loadStoredWeekPlanSnapshot(
    db,
    workspaceId,
    weekStart,
  );
  if (!snapshot) return plan;
  const candidate = recoverStaleDraftingItems(
    plan,
    now,
    WEEK_PLAN_DRAFT_LEASE_MS,
    snapshot.updatedAt,
  );
  if (!candidate.recovered) return plan;
  const persisted = await mutateStoredWeekPlan(
    db,
    workspaceId,
    weekStart,
    (current, updatedAt) => {
      const next = recoverStaleDraftingItems(
        current,
        now,
        WEEK_PLAN_DRAFT_LEASE_MS,
        updatedAt,
      );
      return next.recovered ? next.plan : null;
    },
  );
  if (persisted) return persisted;
  return (await loadStoredWeekPlan(db, workspaceId, weekStart)) ?? plan;
}

export async function recoverStaleWeekPlanDraftsAcross(
  db: SupabaseClient,
  workspaceId: string,
  weekStarts: readonly string[],
  now = new Date(),
): Promise<void> {
  for (const week of weekStarts) {
    const plan = await loadStoredWeekPlan(db, workspaceId, week);
    if (!plan) continue;
    await recoverStaleWeekPlanDrafts(db, workspaceId, week, plan, now);
  }
}

export function reopenLegacyDismissedOpportunityItems(
  plan: StoredWeekPlan,
): StoredWeekPlan {
  let changed = false;
  const items = plan.items.map((item) => {
    if (item.kind !== "opportunity" || item.status !== "dismissed") return item;
    changed = true;
    return {
      ...item,
      status: "planned" as const,
      draftId: null,
      draftingStartedAt: null,
    };
  });
  return changed ? { ...plan, items } : plan;
}

/**
 * A previous Agent-feed dismissal incorrectly skipped the matching cadence
 * slot. Cadence has no dismiss action of its own, so every dismissed
 * opportunity item is legacy coupled state and can be safely reopened.
 */
export async function restoreLegacyDismissedOpportunityItems(
  db: SupabaseClient,
  workspaceId: string,
  weekStart: string,
  plan: StoredWeekPlan,
): Promise<StoredWeekPlan> {
  const restored = reopenLegacyDismissedOpportunityItems(plan);
  if (restored === plan) return plan;
  try {
    return (
      (await mutateStoredWeekPlan(db, workspaceId, weekStart, (current) =>
        reopenLegacyDismissedOpportunityItems(current),
      )) ?? restored
    );
  } catch (error) {
    console.error("agent_week_plan_dismissal_recovery_failed", {
      workspace_id: workspaceId,
      message: error instanceof Error ? error.message : String(error),
    });
    return restored;
  }
}

export async function markStoredOpportunityDrafted(
  db: SupabaseClient,
  workspaceId: string,
  weekStart: string,
  opportunityId: string,
  draftId: string | null = null,
): Promise<void> {
  await mutateStoredWeekPlan(
    db,
    workspaceId,
    weekStart,
    (plan) => ({
      ...plan,
      items: plan.items.map((item) =>
        item.opportunity?.id === opportunityId
          ? {
              ...item,
              status: "drafted",
              draftId,
              draftingStartedAt: null,
            }
          : item,
      ),
    }),
  );
}
