import {
  admitDistinctModelingSource,
  normalizeModelingSourceCandidate,
} from "@/lib/modeling-source-candidate";
import { rotateFreshBand } from "@/lib/idea-ranking";

const MAX_SELECTION = 50;
const MAX_RESERVES = 5;
const MAX_CANDIDATES = 120;
const MAX_CANDIDATE_SCAN = 1_000;

export type ModelingSourceCandidate = {
  id: string;
  text?: unknown;
  post_url?: unknown;
  url?: unknown;
};

export type ModelingSourceSelectionInput<T extends ModelingSourceCandidate> = {
  // The caller owns ranking (for example newest-first or viral-score-first).
  // Selection preserves that order inside each freshness partition.
  candidates: readonly T[];
  limit: number;
  usedIds: ReadonlySet<string>;
  surfacedIds?: ReadonlySet<string>;
  // Optional durable per-workspace rotation cursor (see
  // lib/agent/tools.ts's nextRotationCursor / claim_modeling_source_rotation_cursor
  // RPC). Rotates ONLY the leading never-used/never-surfaced band — the same
  // primitive lib/idea-ranking.ts's rotateFreshBand already uses for ordinary
  // idea discovery — so a caller that advances this cursor on every call cycles
  // through the fresh band instead of always returning its first entries.
  // Omitted or 0 preserves the exact prior (deterministic top-of-rank) behavior.
  rotationCursor?: number;
  // Hard cooldown: these ids are pushed behind EVERY other candidate — they
  // can never lead, and only re-enter as a last-resort top-up when the
  // eligible pool can't fill the limit. This is what stops the same just-
  // modeled post from being re-picked on every chat; the top-up guarantee
  // means a small swipe file never dead-ends a generation over the cooldown.
  excludeIds?: ReadonlySet<string>;
};

export type ModelingSourcePoolInput<T extends ModelingSourceCandidate> =
  ModelingSourceSelectionInput<T> & {
    reserveLimit?: number;
  };

export type SelectedModelingSource<T> = T & {
  already_used: boolean;
  recently_surfaced: boolean;
};

export type ModelingSourcePool<T> = {
  primaries: Array<SelectedModelingSource<T>>;
  reserves: Array<SelectedModelingSource<T>>;
};

function boundedLimit(value: number, maximum: number): number {
  if (value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return maximum;
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

/**
 * Select sources without attempting to interpret their topic or writing style.
 * Retrieval establishes relevance and ordering; this boundary only validates
 * records and applies stable freshness preference.
 */
export function selectModelingSourcePool<T extends ModelingSourceCandidate>(
  input: ModelingSourcePoolInput<T>,
): ModelingSourcePool<T> {
  const limit = boundedLimit(input.limit, MAX_SELECTION);
  const reserveLimit = boundedLimit(input.reserveLimit ?? 0, MAX_RESERVES);
  if (limit === 0 || input.candidates.length === 0) {
    return { primaries: [], reserves: [] };
  }

  const surfacedIds = input.surfacedIds ?? new Set<string>();
  const candidateFingerprints = new Set<string>();
  const candidates: Array<SelectedModelingSource<T>> = [];

  for (const candidate of input.candidates.slice(0, MAX_CANDIDATE_SCAN)) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const normalized = normalizeModelingSourceCandidate(candidate);
    if (
      !normalized ||
      !admitDistinctModelingSource(normalized, candidateFingerprints)
    ) {
      continue;
    }
    candidates.push({
      ...candidate,
      id: normalized.id,
      text: normalized.text,
      already_used: input.usedIds.has(normalized.id),
      recently_surfaced: surfacedIds.has(normalized.id),
    });
  }

  // Stable partitions: never-used and never-surfaced candidates come first,
  // while the caller's ordering is retained inside each partition.
  const stableRanked = [...candidates].sort((left, right) => {
    const used = Number(left.already_used) - Number(right.already_used);
    if (used !== 0) return used;
    return Number(left.recently_surfaced) - Number(right.recently_surfaced);
  });

  // Rotate the leading fresh band by the caller's durable cursor (if any) so
  // repeated calls cycle through it instead of always starting at its first
  // entry — the same primitive lib/idea-ranking.ts's rotateFreshBand already
  // uses for ordinary idea discovery. used/surfaced candidates never lead
  // (rotateFreshBand only touches the fresh prefix), so freshness priority is
  // unaffected; this only changes WHICH already-fresh candidate leads.
  const rotated = input.rotationCursor
    ? rotateFreshBand(stableRanked, input.rotationCursor, limit)
    : stableRanked;

  // Cooldown tail: excluded ids sit behind everything, so they are picked
  // only when the rest of the pool can't fill the request. They keep the
  // caller's order among themselves and are flagged already_used (they're on
  // cooldown precisely because they were just modeled).
  const excludeIds = input.excludeIds ?? new Set<string>();
  const ranked = excludeIds.size
    ? [
        ...rotated.filter((candidate) => !excludeIds.has(candidate.id)),
        ...rotated
          .filter((candidate) => excludeIds.has(candidate.id))
          .map((candidate) => ({ ...candidate, already_used: true })),
      ]
    : rotated;

  const primaries = ranked.slice(0, limit);
  const reserves = ranked.slice(limit, limit + reserveLimit);

  return {
    primaries,
    reserves,
  };
}

export function selectModelingSources<T extends ModelingSourceCandidate>(
  input: ModelingSourceSelectionInput<T>,
): Array<SelectedModelingSource<T>> {
  return selectModelingSourcePool({ ...input, reserveLimit: 0 }).primaries;
}
