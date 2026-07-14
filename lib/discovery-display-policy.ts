export const INITIAL_DISCOVERY_CREATOR_COUNT = 12;
export const DISCOVERY_CREATOR_BATCH_SIZE = 12;
export const INITIAL_SOURCE_CREATOR_COUNT = 20;
export const SOURCE_CREATOR_BATCH_SIZE = 20;
export const CREATOR_CARD_GRID_CLASS = "grid gap-4 lg:grid-cols-2";

export function getCreatorDisplayWindow(
  totalCount: number,
  requestedCount: number,
  batchSize: number,
) {
  const visibleCount = Math.min(Math.max(requestedCount, 0), totalCount);
  const remainingCount = Math.max(totalCount - visibleCount, 0);

  return {
    visibleCount,
    remainingCount,
    nextCount: Math.min(batchSize, remainingCount),
  };
}

export function getStarterPackTrackingSummary(
  totalCount: number,
  untrackedCount: number,
) {
  const safeUntrackedCount = Math.min(Math.max(untrackedCount, 0), totalCount);
  const alreadyTrackedCount = totalCount - safeUntrackedCount;

  if (safeUntrackedCount === 0) {
    return {
      alreadyTrackedCount,
      untrackedCount: safeUntrackedCount,
      detail: `${totalCount} total · ${alreadyTrackedCount} already tracked · 0 to add`,
      actionLabel: "Pack is tracked",
    };
  }

  return {
    alreadyTrackedCount,
    untrackedCount: safeUntrackedCount,
    detail: `${totalCount} total · ${alreadyTrackedCount} already tracked · ${safeUntrackedCount} to add`,
    actionLabel: `Track ${safeUntrackedCount} ${safeUntrackedCount === 1 ? "creator" : "creators"}`,
  };
}
