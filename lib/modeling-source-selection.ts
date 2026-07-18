import { scorePostModelability } from "./post-modelability";

const MAX_SELECTION = 50;
const MAX_CANDIDATES = 120;
const MAX_CANDIDATE_TEXT_CHARS = 12_000;
const MAX_CONTEXT_FIELD_CHARS = 2_000;
const MAX_CONTEXT_VALUES = 32;
const MAX_ANCHOR_TERMS = 160;
const QUALITY_ROTATION_TOLERANCE = 0.05;

const STOP_TERMS = new Set([
  "a", "about", "after", "all", "an", "and", "another", "any", "as",
  "at", "be", "best", "but", "by", "choose", "content", "create", "draft", "file",
  "find", "fit", "fits", "for", "from", "get", "give", "high", "i", "in",
  "into", "it", "keep", "make", "me", "model", "modeled", "modelling", "my",
  "of", "on", "one", "original", "performing", "post", "posts", "regular",
  "hook", "rewrite", "show", "source", "sources", "structure", "style", "swipe",
  "that", "the", "their", "this", "to", "top", "topic", "use", "viral", "voice", "want", "with",
  "write", "writes", "you",
]);

export type ModelingClientContext = {
  userInstruction?: string;
  voiceAnchors?: {
    identity?: readonly string[];
    topics?: readonly string[];
    positioning?: readonly string[];
    audience?: readonly string[];
    painPoints?: readonly string[];
    outcomes?: readonly string[];
  };
};

export type ModelingSourceCandidate = {
  id: string;
  text?: unknown;
  post_type?: unknown;
  media_type?: unknown;
  accounts?: unknown;
};

export type ModelingSourceSelectionInput<T extends ModelingSourceCandidate> = {
  // Ordered by the caller's base retrieval contract (viral score or recency).
  candidates: readonly T[];
  limit: number;
  usedIds: ReadonlySet<string>;
  surfacedIds?: ReadonlySet<string>;
  rotationCursor?: number;
  clientContext?: ModelingClientContext;
};

type SelectedCandidate<T> = T & {
  already_used: boolean;
  recently_surfaced: boolean;
};

type RankedCandidate<T> = SelectedCandidate<T> & {
  selectionIndex: number;
  selectionRejected: boolean;
  selectionQuality: number;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, MAX_CONTEXT_FIELD_CHARS)
    : "";
}

function normalizedTerm(value: string): string {
  const lower = value.normalize("NFKC").toLocaleLowerCase("en-US");
  if (lower.length > 4 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.length > 4 && lower.endsWith("s") && !lower.endsWith("ss")) {
    return lower.slice(0, -1);
  }
  return lower;
}

function termsOf(value: unknown, maxChars: number): string[] {
  if (typeof value !== "string") return [];
  const tokens = (value
    .slice(0, maxChars)
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) ?? [])
    .map(normalizedTerm);
  const terms: string[] = [];
  for (const term of tokens) {
    if (term.length < 2 || STOP_TERMS.has(term)) continue;
    terms.push(term);
  }
  // Preserve multiword topics whose individual words are generic in command
  // language (for example "content writing"). A phrase is admitted only when
  // at least one word is meaningful by itself; generic command pairs such as
  // "make content" and "content original" stay excluded.
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (left.length < 2 || right.length < 2) continue;
    if (STOP_TERMS.has(left) && STOP_TERMS.has(right)) continue;
    terms.push(`${left} ${right}`);
  }
  return terms;
}

function addAnchors(
  anchors: Map<string, number>,
  value: unknown,
  weight: number,
): void {
  if (anchors.size >= MAX_ANCHOR_TERMS) return;
  for (const term of termsOf(boundedString(value), MAX_CONTEXT_FIELD_CHARS)) {
    anchors.set(term, Math.max(weight, anchors.get(term) ?? 0));
    if (anchors.size >= MAX_ANCHOR_TERMS) break;
  }
}

function addAnchorCollection(
  anchors: Map<string, number>,
  value: unknown,
  weight: number,
): void {
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, MAX_CONTEXT_VALUES)) {
      addAnchors(anchors, entry, weight);
    }
    return;
  }
  addAnchors(anchors, value, weight);
}

function relevanceAnchors(context: ModelingClientContext | undefined): Map<string, number> {
  const anchors = new Map<string, number>();
  addAnchors(anchors, context?.userInstruction, 5);
  const voice = context?.voiceAnchors;
  addAnchorCollection(anchors, voice?.identity, 2);
  addAnchorCollection(anchors, voice?.topics, 5);
  addAnchorCollection(anchors, voice?.positioning, 4);
  addAnchorCollection(anchors, voice?.audience, 4);
  addAnchorCollection(anchors, voice?.painPoints, 3);
  addAnchorCollection(anchors, voice?.outcomes, 3);
  return anchors;
}

function accountFields(value: unknown): { name: string; niche: string } {
  const account = recordOf(Array.isArray(value) ? value[0] : value);
  return {
    name: boundedString(account?.name),
    niche: boundedString(account?.niche),
  };
}

function relevanceScore(
  candidate: ModelingSourceCandidate,
  anchors: ReadonlyMap<string, number>,
): number {
  if (anchors.size === 0) return 0;
  const bodyTerms = new Set(termsOf(candidate.text, MAX_CANDIDATE_TEXT_CHARS));
  const nicheTerms = new Set(
    termsOf(accountFields(candidate.accounts).niche, MAX_CONTEXT_FIELD_CHARS),
  );
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const [term, weight] of anchors) {
    totalWeight += weight;
    if (bodyTerms.has(term)) matchedWeight += weight;
    else if (nicheTerms.has(term)) matchedWeight += weight * 0.1;
  }
  return totalWeight > 0 ? matchedWeight / totalWeight : 0;
}

function withoutSelectionMetadata<T extends ModelingSourceCandidate>(
  candidate: RankedCandidate<T>,
): SelectedCandidate<T> {
  const selected = { ...candidate } as Record<string, unknown>;
  delete selected.selectionIndex;
  delete selected.selectionQuality;
  delete selected.selectionRejected;
  return selected as SelectedCandidate<T>;
}

function rotateQualityPool<T>(
  ranked: RankedCandidate<T>[],
  cursor: number,
  limit: number,
): RankedCandidate<T>[] {
  let eligible = 0;
  const bestQuality = ranked[0]?.selectionQuality ?? 0;
  const bestRejected = ranked[0]?.selectionRejected ?? false;
  // Match the tools' bounded 6x over-fetch: equal-quality sources can all
  // rotate, while the tolerance prevents materially weaker sources from
  // entering the rotation merely because the pool is large.
  const maxPool = Math.max(limit + 1, limit * 6);
  while (
    eligible < ranked.length &&
    eligible < maxPool &&
    !ranked[eligible].already_used &&
    !ranked[eligible].recently_surfaced &&
    ranked[eligible].selectionRejected === bestRejected &&
    bestQuality - ranked[eligible].selectionQuality <= QUALITY_ROTATION_TOLERANCE
  ) {
    eligible += 1;
  }
  if (eligible <= limit) return ranked;
  const safeCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
  const offset = ((safeCursor % eligible) + eligible) % eligible;
  if (offset === 0) return ranked;
  const pool = ranked.slice(0, eligible);
  return [
    ...pool.slice(offset),
    ...pool.slice(0, offset),
    ...ranked.slice(eligible),
  ];
}

/**
 * Deterministically chooses sources the system will model on the user's
 * behalf. Explicit analytical rankings and user-selected source ids must not
 * call this function; those are retrieval contracts, not selection problems.
 */
export function selectModelingSources<T extends ModelingSourceCandidate>(
  input: ModelingSourceSelectionInput<T>,
): Array<SelectedCandidate<T>> {
  const requestedLimit = input.limit === Number.NEGATIVE_INFINITY
    ? 0
    : Number.isFinite(input.limit)
      ? Math.max(0, Math.floor(input.limit))
      : input.candidates.length;
  const limit = Math.min(MAX_SELECTION, requestedLimit);
  if (limit === 0 || input.candidates.length === 0) return [];

  const uniqueCandidates: T[] = [];
  const candidateIds = new Set<string>();
  for (const candidate of input.candidates.slice(0, MAX_CANDIDATES)) {
    if (
      !candidate ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      candidateIds.has(candidate.id)
    ) {
      continue;
    }
    candidateIds.add(candidate.id);
    uniqueCandidates.push(candidate);
  }

  const anchors = relevanceAnchors(input.clientContext);
  const surfacedIds = input.surfacedIds ?? new Set<string>();
  const ranked: RankedCandidate<T>[] = uniqueCandidates
    .map((candidate, selectionIndex) => {
      const modelability = scorePostModelability({
        text: candidate.text as string,
        postType: candidate.post_type === "lead_magnet" ? "lead_magnet" : "regular",
        mediaType: typeof candidate.media_type === "string"
          ? candidate.media_type
          : null,
      });
      const relevance = relevanceScore(candidate, anchors);
      return {
        ...candidate,
        already_used: input.usedIds.has(candidate.id),
        recently_surfaced: surfacedIds.has(candidate.id),
        selectionIndex,
        selectionRejected: modelability.reject !== null,
        selectionQuality: modelability.score * 0.65 + relevance * 0.35,
      };
    })
    .sort((left, right) => {
      const rejectedDiff =
        Number(left.selectionRejected) - Number(right.selectionRejected);
      if (rejectedDiff !== 0) return rejectedDiff;
      const usedDiff = Number(left.already_used) - Number(right.already_used);
      if (usedDiff !== 0) return usedDiff;
      const surfacedDiff =
        Number(left.recently_surfaced) - Number(right.recently_surfaced);
      if (surfacedDiff !== 0) return surfacedDiff;
      const qualityDiff = right.selectionQuality - left.selectionQuality;
      if (Math.abs(qualityDiff) > Number.EPSILON) return qualityDiff;
      return left.selectionIndex - right.selectionIndex;
    });

  const rotated = rotateQualityPool(
    ranked,
    input.rotationCursor ?? 0,
    limit,
  );
  const perAuthorCap = Math.max(1, Math.ceil(limit / 2));
  const authorCounts = new Map<string, number>();
  const picked: RankedCandidate<T>[] = [];
  const skipped: RankedCandidate<T>[] = [];
  for (const candidate of rotated) {
    if (picked.length >= limit) break;
    if (
      candidate.selectionRejected &&
      skipped.some((skippedCandidate) => !skippedCandidate.selectionRejected)
    ) {
      skipped.push(candidate);
      continue;
    }
    const authorName = accountFields(candidate.accounts).name;
    const authorKey = authorName || `unknown:${candidate.id}`;
    const count = authorCounts.get(authorKey) ?? 0;
    if (count < perAuthorCap) {
      picked.push(candidate);
      authorCounts.set(authorKey, count + 1);
    } else {
      skipped.push(candidate);
    }
  }
  for (const candidate of skipped) {
    if (picked.length >= limit) break;
    picked.push(candidate);
  }

  return picked.map(withoutSelectionMetadata);
}
