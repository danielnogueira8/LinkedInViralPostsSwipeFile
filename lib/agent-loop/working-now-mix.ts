// ---------------------------------------------------------------------------
// "Working now" opportunity mix.
//
// The briefing's "Working now" panel shows a fixed number of opportunities to
// draft. Left to raw score, the panel could be all lead magnets or all regular
// posts on a given day. The user wants a healthy content balance — by default
// 2 regular posts + 1 lead magnet — so this composes the visible slots from a
// larger scored candidate pool.
//
// The target is a preference, not a hard rule: if the bank is short on one type,
// the remaining slots are backfilled from the other type so the panel still
// fills up (better to show 3 regular posts than to leave a slot empty because
// no lead magnet is available). Pure + exported so the composition is unit
// tested without a DB.
// ---------------------------------------------------------------------------

/** The default "Working now" size and per-type targets. */
export const WORKING_NOW_TOTAL = 3;
export const WORKING_NOW_LEAD_MAGNET_TARGET = 1;
export const WORKING_NOW_REGULAR_TARGET =
  WORKING_NOW_TOTAL - WORKING_NOW_LEAD_MAGNET_TARGET;

// How many proposed opportunities to pull as the candidate pool the mix is
// composed from. Bigger than WORKING_NOW_TOTAL so the mixer can actually find a
// lead magnet and a couple of regular posts, but bounded so the follow-up
// posts IN-query stays cheap. A day rarely proposes more than a handful.
export const WORKING_NOW_POOL_LIMIT = 12;

/** Minimal shape the mixer needs: enough to split by type and keep order. */
export type MixableOpportunity = {
  is_lead_magnet?: boolean;
};

/**
 * Compose the visible "Working now" set from a scored candidate pool.
 *
 * `pool` MUST already be sorted best-first (highest score first) — the mixer
 * preserves that order within each type, so the strongest regular posts and the
 * strongest lead magnet are the ones that surface.
 *
 * Behaviour:
 *  - Take up to `regularTarget` regular posts and `leadMagnetTarget` lead
 *    magnets (each in pool order).
 *  - If either type can't meet its target, backfill the leftover slots from the
 *    other type's remaining candidates (still best-first) so `total` slots fill
 *    whenever the pool is large enough.
 *  - Never exceeds `total`; returns fewer only when the pool itself is smaller.
 *
 * The returned items are references from `pool` (no copies), de-duplicated by
 * identity, and returned in a stable order: chosen regular posts first, then
 * the chosen lead magnet(s), then any backfill — so the panel reads
 * "posts, then giveaway" rather than interleaving unpredictably.
 */
export function composeWorkingNowMix<T extends MixableOpportunity>(
  pool: readonly T[],
  {
    total = WORKING_NOW_TOTAL,
    leadMagnetTarget = WORKING_NOW_LEAD_MAGNET_TARGET,
    regularTarget = WORKING_NOW_REGULAR_TARGET,
  }: { total?: number; leadMagnetTarget?: number; regularTarget?: number } = {},
): T[] {
  const regular = pool.filter((o) => !o.is_lead_magnet);
  const leadMagnets = pool.filter((o) => o.is_lead_magnet);

  const chosen: T[] = [];
  const picked = new Set<T>();
  const take = (from: readonly T[], n: number) => {
    for (const item of from) {
      if (chosen.length >= total) break;
      if (n <= 0) break;
      if (picked.has(item)) continue;
      picked.add(item);
      chosen.push(item);
      n -= 1;
    }
  };

  // First pass: honour each type's target (posts first so the panel leads with
  // regular content, matching the "2 posts + 1 giveaway" intent).
  take(regular, regularTarget);
  take(leadMagnets, leadMagnetTarget);

  // Backfill any unmet slots from whatever's left — the target is a preference,
  // so a thin bank of one type still fills the panel with the other.
  if (chosen.length < total) {
    take(regular, total - chosen.length);
  }
  if (chosen.length < total) {
    take(leadMagnets, total - chosen.length);
  }

  return chosen;
}
