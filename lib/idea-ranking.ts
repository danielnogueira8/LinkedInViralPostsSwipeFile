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
