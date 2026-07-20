import { supabaseAdmin } from "./supabase";

export type ViralThresholds = { min_reactions: number; min_comments: number };

// ─────────────────────────────────────────────────────────────────────────
// Per-workspace classification (foundation — see db/migration-075).
//
// posts.is_viral is GLOBAL: it's stamped once at ingest using whichever
// workspace's thresholds happened to trigger that scrape (or the fallback
// default for the unattended cron run). Two workspaces tracking the same
// creator (common — onboarding offers a shared category catalog) get
// cross-contaminated classification: workspace A's saved thresholds silently
// decide what workspace B sees for a post neither of them is even aware the
// other tracks.
//
// This writes workspace_post_classification for EVERY workspace currently
// tracking the scraped post's account, each judged against ITS OWN saved
// thresholds — so the global posts.is_viral column keeps working exactly as
// before (nothing reads this table yet) while the correct per-workspace data
// accumulates for a follow-up PR to switch reads onto.
// ─────────────────────────────────────────────────────────────────────────

// Called once per upserted post, right after the global is_viral write. Never
// throws — a failure here must not fail the scrape (the global column is
// still the source of truth until reads are flipped).
export async function classifyPostForAllWorkspaces(
  postId: string,
  accountId: string,
  reactions: number,
  comments: number,
): Promise<void> {
  const sb = supabaseAdmin();
  try {
    const { data: trackers, error: trackersErr } = await sb
      .from("workspace_accounts")
      .select("workspace_id")
      .eq("account_id", accountId);
    if (trackersErr) throw trackersErr;
    const workspaceIds = [...new Set((trackers ?? []).map((r) => r.workspace_id as string))];
    if (workspaceIds.length === 0) return;

    const rows = await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        const t = await getThresholds(workspaceId);
        return {
          workspace_id: workspaceId,
          post_id: postId,
          is_viral: meetsThreshold(reactions, comments, t),
          viral_basis: "flat_threshold",
          computed_at: new Date().toISOString(),
        };
      }),
    );
    const { error: upsertErr } = await sb
      .from("workspace_post_classification")
      .upsert(rows, { onConflict: "workspace_id,post_id" });
    if (upsertErr) throw upsertErr;
  } catch (e) {
    console.warn(
      `workspace_post_classification write failed for post ${postId}: ${(e as Error).message}`,
    );
  }
}

// A viral post must clear the user's minimum reactions OR comments (their
// "quality floor" for anything entering the swipe file). The default is
// intentionally low (50/50) so a fresh workspace with a mix of small and
// big creators still gets a real swipe file to work with; users tune it up
// per workspace in /dashboard/settings. Was 200/50 before — that was tuned
// for the big-creator default account list and made small-creator posts
// invisible on new workspaces.
const DEFAULT_VIRAL = { min_reactions: 50, min_comments: 50 };
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
// Relative (per-creator) virality — percentile + user-set floor
//
// A single flat threshold treats every creator the same: a 500k-follower
// creator clears it every day, and a strong over-performance from a 3k-
// follower creator never does. Instead we judge each post against the
// creator's OWN typical performance and only surface their top slice.
//
//   viral  ⇔  reactions ≥ min_reactions OR comments ≥ min_comments  (user floor)
//             AND ( not enough history  → floor alone decides
//                   enough history      → score ≥ P(cutoff) of the creator's
//                                          recent scores — top 20% by default )
//
// - The FLOOR is the user's per-workspace flat threshold (settings page).
//   That's the "how strong does this need to be at all" gate; it's an OR of
//   reactions and comments so a post that lands hard on one axis still
//   qualifies. If the user sets 50/50, nothing under 50/50 leaks in.
// - The BASELINE is the (100 - cutoffPct)-th percentile of the creator's last
//   WINDOW posts. Default cutoff 20 means we surface only the top 20% of each
//   creator's own posts. Percentile (not median × multiplier) makes the
//   selectivity explicit — "top 20% per creator" instead of a fuzzy multiplier.
// - Cold start: creators with < MIN_HISTORY stored posts have no trustworthy
//   percentile, so the flat floor alone decides.
//
// All inputs come from data we already store in `posts` (one row per creator
// per run) — zero extra Apify scraping.
// ─────────────────────────────────────────────────────────────────────────

export type RelativeViralConfig = {
  /** Min stored posts (excluding the one being judged) before we trust a
   *  per-creator baseline. Below this we fall back to the flat threshold. */
  minHistory: number;
  /** How many of the creator's most recent posts feed the baseline. */
  window: number;
  /** Surface the TOP N % of the creator's posts, where N is this value.
   *  Default 20 → viral posts are in the top 20% by score, per creator. */
  cutoffPct: number;
};

const DEFAULT_RELATIVE: RelativeViralConfig = {
  minHistory: Number(process.env.VIRAL_REL_MIN_HISTORY ?? 5),
  window: Number(process.env.VIRAL_REL_WINDOW ?? 15),
  cutoffPct: Number(process.env.VIRAL_REL_CUTOFF_PCT ?? 20),
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

/**
 * The Pth-percentile value from a numeric array using linear interpolation
 * between the two neighboring ranks (the same "P.LINEAR" rule Excel /
 * PostgreSQL's percentile_cont use). `p` is 0–100 inclusive. Empty array →
 * null. Pure + exported for tests.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  // Rank in [0, n-1] using the linear-interpolation convention.
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export type RelativeViralDecision = {
  viral: boolean;
  /** Which rule decided it — useful for the dashboard / dry-run reporting.
   *  - "flat_fallback": below MIN_HISTORY, only the user's flat floor applied.
   *  - "below_floor": failed the user's flat floor; percentile not consulted.
   *  - "relative": cleared the floor and was compared to the percentile. */
  basis: "relative" | "flat_fallback" | "below_floor";
  baseline: number | null; // creator percentile cutoff used (null when fallback)
  sampleSize: number; // how many prior posts fed the baseline
};

/**
 * Pure decision: given this post's score and the creator's prior scores
 * (most-recent first or any order — we window + percentile internally),
 * decide viral. `flatThresholds` is the user's per-workspace floor; nothing
 * under it is ever viral, however well it scores relative to a creator's
 * own posts.
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

  // The user's flat threshold IS the absolute floor — nothing below it can be
  // viral, however strong it looks against a low-engagement creator's own
  // history. This is what the settings page copy promises ("A post appears
  // when reactions or comments meet the minimum") and it applies to BOTH
  // paths: the cold-start (no history) and the percentile path below.
  const clearsFloor = meetsThreshold(args.reactions, args.comments, args.flatThresholds);

  // Cold start: not enough history for a per-creator baseline → the floor
  // decides on its own.
  if (sampleSize < cfg.minHistory) {
    return { viral: clearsFloor, basis: "flat_fallback", baseline: null, sampleSize };
  }

  // Enough history: check the floor FIRST (cheap OR check) so a below-floor
  // post surfaces as "below_floor" in the basis for reporting — not as an
  // ambiguous "beat the percentile with 3 likes".
  if (!clearsFloor) {
    // We still compute the cutoff for reporting so the dashboard can show
    // "would have needed X score to be top 20%" even for below-floor posts.
    const cutoff = percentile(sample, 100 - cfg.cutoffPct) ?? 0;
    return { viral: false, basis: "below_floor", baseline: cutoff, sampleSize };
  }

  // Above the floor AND above the top-N% cutoff of the creator's recent posts.
  const cutoff = percentile(sample, 100 - cfg.cutoffPct) ?? 0;
  const viral = args.score >= cutoff;
  return { viral, basis: "relative", baseline: cutoff, sampleSize };
}

// ─────────────────────────────────────────────────────────────────────────
// Template outliers — the creator's GENUINE outliers, templatized into the
// content_templates library.
//
// A post qualifies ⇔ the creator has at least MIN_HISTORY other stored posts
// AND this post's score is in the creator's own top CUTOFF_PCT % (default:
// top 5% over ≥ 20 prior posts). Deliberately separate from
// decideRelativeViral: that function's cold-start flat-floor fallback exists
// so a thin-history creator can still be viral, but a template generalizes a
// pattern to OTHER creators' audiences — we only trust the percentile once
// the creator's own history is deep enough to make "outlier" meaningful.
// ─────────────────────────────────────────────────────────────────────────

export type TemplateOutlierConfig = {
  /** Min OTHER stored posts before a creator can produce a template outlier
   *  at all. Below this there is no trustworthy percentile, so nothing
   *  qualifies (no fallback — unlike relative virality). */
  minHistory: number;
  /** How many of the creator's most recent posts feed the percentile. */
  window: number;
  /** Surface the TOP N % of the creator's posts, where N is this value.
   *  Default 5 → only the creator's genuine outliers qualify. */
  cutoffPct: number;
};

// Env-overridable, matching the VIRAL_REL_* / HOOK_* pattern. The gate runs
// in the GLOBAL pipeline with no per-workspace context, so there's no
// settings override — one global bar, tunable via env.
const DEFAULT_TEMPLATE_OUTLIER: TemplateOutlierConfig = {
  minHistory: Number(process.env.TEMPLATE_OUTLIER_MIN_HISTORY ?? 20),
  window: Number(process.env.TEMPLATE_OUTLIER_WINDOW ?? 100),
  cutoffPct: Number(process.env.TEMPLATE_OUTLIER_CUTOFF_PCT ?? 5),
};

export function getTemplateOutlierConfig(): TemplateOutlierConfig {
  return { ...DEFAULT_TEMPLATE_OUTLIER };
}

export type TemplateOutlierDecision = {
  qualifies: boolean;
  /** The percentile cutoff the post had to reach (null when the creator is
   *  below MIN_HISTORY and no percentile was computed). */
  baseline: number | null;
  /** How many prior posts fed the percentile. */
  sampleSize: number;
};

/**
 * Pure decision: given this post's score and the creator's prior scores
 * (most-recent first or any order — we window + percentile internally),
 * decide whether this post is a genuine outlier worth templatizing.
 */
export function decideTemplateOutlier(args: {
  score: number;
  priorScores: number[]; // creator's other posts' viral_score (numeric)
  config?: TemplateOutlierConfig;
}): TemplateOutlierDecision {
  const cfg = args.config ?? getTemplateOutlierConfig();
  const sample = args.priorScores.slice(0, cfg.window);
  const sampleSize = sample.length;

  // Not enough history for a trustworthy percentile → never qualifies.
  if (sampleSize < cfg.minHistory) {
    return { qualifies: false, baseline: null, sampleSize };
  }

  const cutoff = percentile(sample, 100 - cfg.cutoffPct) ?? 0;
  return { qualifies: args.score >= cutoff, baseline: cutoff, sampleSize };
}
