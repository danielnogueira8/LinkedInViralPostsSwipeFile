/**
 * The ONE draft-count rule for a turn (PLAN-cowork-unification Phase 1,
 * step 2 COMPILE): every turn resolves to 1-6 drafts, with priority
 * UI override > explicit message count > default 1. Resolution is
 * structural — this function is the only place the priority and the
 * clamp live, and every caller routes through it.
 */
export type TurnCountSource = "ui" | "message" | "default";

export type TurnDraftCount = 1 | 2 | 3 | 4 | 5 | 6;

export const MIN_TURN_DRAFT_COUNT = 1;
export const MAX_TURN_DRAFT_COUNT = 6;

/**
 * A candidate count participates only when it is a finite integer; junk
 * (NaN, Infinity, fractions, non-numbers) falls through to the next
 * source. Valid integers clamp into the 1-6 range instead of being
 * dropped, so "write 10 posts" yields 6, not a silent reset to 1.
 */
function clampedCount(
  value: number | null | undefined,
): TurnDraftCount | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < MIN_TURN_DRAFT_COUNT) return MIN_TURN_DRAFT_COUNT;
  if (value > MAX_TURN_DRAFT_COUNT) return MAX_TURN_DRAFT_COUNT;
  return value as TurnDraftCount;
}

export function resolveTurnCount(input: {
  uiDraftCount?: number | null;
  messageCount?: number | null;
}): { count: TurnDraftCount; source: TurnCountSource } {
  const uiCount = clampedCount(input.uiDraftCount);
  if (uiCount !== null) return { count: uiCount, source: "ui" };
  const messageCount = clampedCount(input.messageCount);
  if (messageCount !== null) return { count: messageCount, source: "message" };
  return { count: MIN_TURN_DRAFT_COUNT, source: "default" };
}
