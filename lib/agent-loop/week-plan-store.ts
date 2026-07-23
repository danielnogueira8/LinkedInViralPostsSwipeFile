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
  status: z.enum(["planned", "drafting", "drafted", "dismissed"]),
  opportunity: z
    .object({
      id: z.string().nullable(),
      headline: z.string(),
      is_lead_magnet: z.boolean(),
      author_avatar: z.string().nullable(),
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
  mutate: (plan: StoredWeekPlan) => StoredWeekPlan | null,
): Promise<StoredWeekPlan | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await loadStoredWeekPlanSnapshot(
      db,
      workspaceId,
      weekStart,
    );
    if (!snapshot) return null;
    const updated = mutate(snapshot.plan);
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

export async function syncStoredOpportunity(
  db: SupabaseClient,
  workspaceId: string,
  weekStart: string,
  opportunityId: string,
  status: "drafted" | "dismissed",
): Promise<void> {
  await mutateStoredWeekPlan(
    db,
    workspaceId,
    weekStart,
    (plan) => ({
      ...plan,
      items: plan.items.map((item) =>
        item.opportunity?.id === opportunityId ? { ...item, status } : item,
      ),
    }),
  );
}
