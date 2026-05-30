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

// ─────────────────────────────────────────────────────────────────────────
// Relative (per-creator) virality — option 4: "hybrid floor + rolling median"
//
// The flat threshold (200 reactions / 50 comments) treats every creator the
// same: a 500k-follower creator clears it on an average day, while a strong
// over-performance from a 3k-follower creator never does. We instead judge a
// post against the *creator's own typical performance*:
//
//   viral  ⇔  score ≥ ABSOLUTE_FLOOR
//             AND ( not enough history  → fall back to the flat threshold
//                   enough history      → score ≥ MULTIPLIER × creator median )
//
// - The MEDIAN (not mean) of the creator's last WINDOW posts' viral_score is
//   the baseline — robust to one freak mega-viral post inflating it.
// - The ABSOLUTE_FLOOR kills false positives for low-engagement creators where
//   "3× a tiny baseline" might still be a handful of reactions.
// - Cold start: a creator with < MIN_HISTORY stored posts has no trustworthy
//   baseline, so we use the existing flat threshold until they accumulate one.
//
// All inputs come from data we already store in `posts` (one row per creator
// per run) — zero extra Apify scraping.
// ─────────────────────────────────────────────────────────────────────────

export type RelativeViralConfig = {
  /** Min stored posts (excluding the one being judged) before we trust a
   *  per-creator baseline. Below this we fall back to the flat threshold. */
  minHistory: number;
  /** How many of the creator's most recent posts feed the median baseline. */
  window: number;
  /** A post is relatively-viral when its score ≥ multiplier × median. */
  multiplier: number;
  /** Hard floor on raw score; a post below this is never viral, however much
   *  it beats a tiny baseline. */
  absoluteFloor: number;
};

const DEFAULT_RELATIVE: RelativeViralConfig = {
  minHistory: Number(process.env.VIRAL_REL_MIN_HISTORY ?? 5),
  window: Number(process.env.VIRAL_REL_WINDOW ?? 15),
  multiplier: Number(process.env.VIRAL_REL_MULTIPLIER ?? 1.3),
  absoluteFloor: Number(process.env.VIRAL_REL_FLOOR ?? 50),
};

export function getRelativeConfig(): RelativeViralConfig {
  return { ...DEFAULT_RELATIVE };
}

/** Median of a numeric array. Returns null for an empty array. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export type RelativeViralDecision = {
  viral: boolean;
  /** Which rule decided it — useful for the dashboard / dry-run reporting. */
  basis: "relative" | "flat_fallback" | "below_floor";
  baseline: number | null; // creator median used (null when fallback)
  sampleSize: number; // how many prior posts fed the baseline
};

/**
 * Pure decision: given this post's score and the creator's prior scores
 * (most-recent first or any order — we window + median internally), decide
 * viral. `flatThresholds` is the existing per-workspace flat threshold used
 * for the cold-start fallback, evaluated against raw reactions/comments.
 */
export function decideRelativeViral(args: {
  score: number;
  reactions: number;
  comments: number;
  priorScores: number[]; // creator's other posts' viral_score (numeric)
  flatThresholds: ViralThresholds;
  config?: RelativeViralConfig;
}): RelativeViralDecision {
  const cfg = args.config ?? getRelativeConfig();
  const sample = args.priorScores.slice(0, cfg.window);
  const sampleSize = sample.length;

  // Cold start: not enough history → flat threshold (and still subject to the
  // floor so we don't disagree with ourselves on tiny posts the flat rule lets
  // through; flat reaction/comment thresholds are already ≥ the floor, so this
  // is a no-op for the default config but stays correct if floor is raised).
  if (sampleSize < cfg.minHistory) {
    const viral = meetsThreshold(args.reactions, args.comments, args.flatThresholds);
    return { viral, basis: "flat_fallback", baseline: null, sampleSize };
  }

  const baseline = median(sample) ?? 0;
  if (args.score < cfg.absoluteFloor) {
    return { viral: false, basis: "below_floor", baseline, sampleSize };
  }
  const viral = args.score >= cfg.multiplier * baseline;
  return { viral, basis: "relative", baseline, sampleSize };
}
