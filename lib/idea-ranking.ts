/** Preserve the caller's base ordering while sinking previously used/surfaced ideas. */
export function rankIdeaPosts<T extends { id: string }>(
  posts: readonly T[],
  usedIds: ReadonlySet<string>,
  surfacedIds: ReadonlySet<string> = new Set(),
): Array<T & { already_used: boolean; recently_surfaced: boolean }> {
  return posts
    .map((post) => ({
      ...post,
      already_used: usedIds.has(post.id),
      recently_surfaced: surfacedIds.has(post.id),
    }))
    .sort((left, right) => {
      const usedDiff = Number(left.already_used) - Number(right.already_used);
      if (usedDiff !== 0) return usedDiff;
      return Number(left.recently_surfaced) - Number(right.recently_surfaced);
    });
}

/** Rotate only the fresh leading band; used/surfaced ideas can never lead. */
export function rotateFreshBand<
  T extends { already_used: boolean; recently_surfaced: boolean },
>(ranked: readonly T[], cursor: number, keep: number): T[] {
  let band = 0;
  while (
    band < ranked.length &&
    !ranked[band].already_used &&
    !ranked[band].recently_surfaced
  ) {
    band += 1;
  }
  if (band <= keep || keep <= 0) return [...ranked];
  const safeCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
  const offset = ((safeCursor % band) + band) % band;
  if (offset === 0) return [...ranked];
  const head = ranked.slice(0, band);
  return [
    ...head.slice(offset),
    ...head.slice(0, offset),
    ...ranked.slice(band),
  ];
}

// A small deterministic PRNG (mulberry32) so a shuffle is reproducible for a
// given seed — same seed → same order (unit-testable), different seed → different
// order. Avoids Math.random so tests can assert exact output.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shuffle ONLY the fresh leading band (posts that are neither already_used nor
 * recently_surfaced), seeded by `cursor`, and leave the used/surfaced tail in
 * place so those never lead. Unlike rotateFreshBand, this varies results even
 * when the fresh band is small (a quiet week) — the case where rotate's
 * `band <= keep` guard returned the identical order every call, so idea
 * discovery kept surfacing the same top N. The durable per-workspace cursor
 * advances each call, so consecutive requests get a genuinely different mix
 * while remaining deterministic for a given seed.
 */
export function shuffleFreshBand<
  T extends { already_used: boolean; recently_surfaced: boolean },
>(ranked: readonly T[], seed: number): T[] {
  let band = 0;
  while (
    band < ranked.length &&
    !ranked[band].already_used &&
    !ranked[band].recently_surfaced
  ) {
    band += 1;
  }
  if (band <= 1) return [...ranked];
  const safeSeed = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  const rand = mulberry32(safeSeed);
  const head = ranked.slice(0, band);
  // Fisher–Yates with the seeded PRNG.
  for (let i = head.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [head[i], head[j]] = [head[j], head[i]];
  }
  return [...head, ...ranked.slice(band)];
}
