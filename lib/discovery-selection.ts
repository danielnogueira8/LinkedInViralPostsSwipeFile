import { rankIdeaPosts, shuffleFreshBand } from "@/lib/idea-ranking";

/**
 * Discovery searches should return a fresh, relevant mix. Explicit analytical
 * rankings keep their requested order instead.
 *
 * Date, topic, niche, and post-type fields only narrow eligibility; they do not
 * ask for an exact ranking and therefore remain eligible for rotation.
 */
export function isVariedDiscoverySearch(
  args: Record<string, unknown>,
): boolean {
  const explicitSort =
    typeof args.sort === "string" && args.sort !== "viral";
  const hasThreshold =
    typeof args.min_reactions === "number" ||
    typeof args.min_comments === "number";

  return (
    args.strict_ranking !== true &&
    !explicitSort &&
    args.dir !== "asc" &&
    !hasThreshold
  );
}

/** Rank freshness first, then deterministically vary the fresh candidate band. */
export function variedDiscoveryOrder<T extends { id: string }>({
  candidates,
  usedIds,
  surfacedIds = new Set<string>(),
  cursor,
}: {
  candidates: readonly T[];
  usedIds: ReadonlySet<string>;
  surfacedIds?: ReadonlySet<string>;
  cursor: number;
}) {
  return shuffleFreshBand(
    rankIdeaPosts(candidates, usedIds, surfacedIds),
    cursor,
  );
}
