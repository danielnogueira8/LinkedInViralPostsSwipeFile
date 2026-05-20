import { supabaseAdmin } from "./supabase";

export type ViralThresholds = { min_reactions: number; min_comments: number };

const DEFAULT_VIRAL = { min_reactions: 200, min_comments: 50 };
const DEFAULT_TEMPLATE = { min_reactions: 500, min_comments: 100 };

async function readThresholds(
  key: string,
  fallback: ViralThresholds,
  workspaceId: string | null,
): Promise<ViralThresholds> {
  const sb = supabaseAdmin();
  // No workspace context (cron/global) → use fallback. Per-workspace overrides
  // are applied at view-time, not in the global pipeline.
  if (!workspaceId) return fallback;
  const { data } = await sb
    .from("settings")
    .select("value")
    .eq("workspace_id", workspaceId)
    .eq("key", key)
    .maybeSingle();
  if (data?.value && typeof data.value === "object") {
    const v = data.value as Partial<ViralThresholds>;
    return {
      min_reactions: v.min_reactions ?? fallback.min_reactions,
      min_comments: v.min_comments ?? fallback.min_comments,
    };
  }
  return fallback;
}

export async function getThresholds(workspaceId: string | null = null): Promise<ViralThresholds> {
  return readThresholds("viral_thresholds", {
    min_reactions: Number(process.env.VIRAL_MIN_REACTIONS ?? DEFAULT_VIRAL.min_reactions),
    min_comments: Number(process.env.VIRAL_MIN_COMMENTS ?? DEFAULT_VIRAL.min_comments),
  }, workspaceId);
}

export async function getTemplateThresholds(workspaceId: string | null = null): Promise<ViralThresholds> {
  return readThresholds("template_thresholds", DEFAULT_TEMPLATE, workspaceId);
}

export function score(reactions: number, comments: number, reposts: number): number {
  return reactions + comments * 3 + reposts * 5;
}

export function meetsThreshold(reactions: number, comments: number, t: ViralThresholds): boolean {
  return reactions >= t.min_reactions || comments >= t.min_comments;
}

export const isViral = meetsThreshold;
