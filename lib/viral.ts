import { supabaseAdmin } from "./supabase";

export type ViralThresholds = { min_reactions: number; min_comments: number };

export async function getThresholds(): Promise<ViralThresholds> {
  const sb = supabaseAdmin();
  const { data } = await sb.from("settings").select("value").eq("key", "viral_thresholds").maybeSingle();
  if (data?.value && typeof data.value === "object") {
    const v = data.value as Partial<ViralThresholds>;
    return {
      min_reactions: v.min_reactions ?? Number(process.env.VIRAL_MIN_REACTIONS ?? 200),
      min_comments: v.min_comments ?? Number(process.env.VIRAL_MIN_COMMENTS ?? 50),
    };
  }
  return {
    min_reactions: Number(process.env.VIRAL_MIN_REACTIONS ?? 200),
    min_comments: Number(process.env.VIRAL_MIN_COMMENTS ?? 50),
  };
}

export function score(reactions: number, comments: number, reposts: number): number {
  return reactions + comments * 3 + reposts * 5;
}

export function isViral(reactions: number, comments: number, t: ViralThresholds): boolean {
  return reactions >= t.min_reactions || comments >= t.min_comments;
}
