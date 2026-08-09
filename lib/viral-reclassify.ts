import {
  decideRelativeViral,
  RELATIVE_CUTOFF_DISABLED,
  score,
  type RelativeViralConfig,
  type ViralThresholds,
} from "./viral";

// ---------------------------------------------------------------------------
// Recompute posts.is_viral for the existing corpus.
//
// is_viral is stamped once at ingest and nothing in the app ever recomputes it
// — deliberately, because it is a GLOBAL column shared by every workspace and a
// per-workspace threshold change must never rewrite it (see the long note in
// app/api/settings/route.ts). The cost of that safety is that a bad GLOBAL rule
// leaves permanent damage: VIRAL_REL_CUTOFF_PCT=30 in production meant every
// post outside its creator's top 30% was stamped false at ingest, and removing
// the variable only helps posts scraped afterwards.
//
// This is the one legitimate case for a bulk rewrite: recomputing the global
// column with the current GLOBAL rule, which is exactly what ingest would do
// today. It is not a per-workspace decision, so it cannot contaminate anyone —
// workspace overrides live in workspace_post_classification and are untouched.
//
// The planner is pure so the decision can be tested without a database; the
// script (scripts/reclassify-viral.ts) owns the I/O.
// ---------------------------------------------------------------------------

export type ReclassifiablePost = {
  id: string;
  reactions: number;
  comments: number;
  reposts: number;
  viral_score: number | null;
  is_viral: boolean;
};

export type ReclassificationPlan = {
  /** Stamped false, qualifies under the current rule — the posts to get back. */
  recover: string[];
  /** Stamped true, does NOT qualify — hiding these is destructive, so the
   *  script keeps them behind an explicit opt-in. */
  demote: string[];
  unchanged: number;
  /** Stored viral_score disagrees with score() over the stored engagement.
   *  Reported, never written: viral_score drives sort order and the relative
   *  baseline, so a divergence is its own bug rather than something to fix as
   *  a side effect of a virality rewrite. */
  staleScores: string[];
};

/**
 * The planner evaluates the flat floor alone, which is only correct while the
 * per-creator gate is off. With a cutoff below 100 the verdict depends on each
 * creator's recent history, and a history-free pass would confidently rewrite
 * the whole table with the wrong answer.
 *
 * So this throws rather than degrading. A reclassification that is silently
 * wrong is worse than one that refuses to start.
 */
export function assertFlatOnlyConfig(config: RelativeViralConfig): void {
  if (config.cutoffPct < RELATIVE_CUTOFF_DISABLED) {
    throw new Error(
      `Refusing to reclassify: the relative gate is on (cutoffPct=${config.cutoffPct}). ` +
        "This pass judges posts on the flat floor alone, which is only the whole " +
        "rule while the per-creator percentile is disabled. Reclassifying under a " +
        "live percentile needs each creator's history rebuilt as of each post.",
    );
  }
}

export function planReclassification(
  posts: readonly ReclassifiablePost[],
  thresholds: ViralThresholds,
  config: RelativeViralConfig,
): ReclassificationPlan {
  assertFlatOnlyConfig(config);

  const plan: ReclassificationPlan = {
    recover: [],
    demote: [],
    unchanged: 0,
    staleScores: [],
  };

  for (const post of posts) {
    const computed = score(post.reactions, post.comments, post.reposts);
    if (post.viral_score != null && Number(post.viral_score) !== computed) {
      plan.staleScores.push(post.id);
    }

    // Routed through the real decision function rather than calling
    // meetsThreshold directly, so this pass cannot drift from what the pipeline
    // does at ingest. With the gate disabled it short-circuits before reading
    // priorScores, which is what makes the empty array safe here — and
    // assertFlatOnlyConfig above is what keeps that true.
    const decision = decideRelativeViral({
      score: computed,
      reactions: post.reactions,
      comments: post.comments,
      priorScores: [],
      flatThresholds: thresholds,
      config,
    });

    if (decision.viral === post.is_viral) {
      plan.unchanged += 1;
    } else if (decision.viral) {
      plan.recover.push(post.id);
    } else {
      plan.demote.push(post.id);
    }
  }

  return plan;
}

/** Columns every reclassified row gets, whichever direction it moved. The
 *  basis is flat_fallback and the baseline null because the gate is off —
 *  assertFlatOnlyConfig guarantees that. */
export function reclassifiedColumns(isViral: boolean): {
  is_viral: boolean;
  viral_basis: string;
  baseline_score: number | null;
} {
  return { is_viral: isViral, viral_basis: "flat_fallback", baseline_score: null };
}
