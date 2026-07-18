import { scorePostModelability } from "./post-modelability";

const MAX_SELECTION = 50;
const MAX_RESERVES = 5;
const MAX_CANDIDATES = 120;
const MAX_CANDIDATE_TEXT_CHARS = 12_000;
const MAX_CONTEXT_FIELD_CHARS = 2_000;
const MAX_CONTEXT_VALUES = 32;
const MAX_ANCHOR_TERMS = 160;
const QUALITY_ROTATION_TOLERANCE = 0.05;

const STOP_TERMS = new Set([
  "a", "about", "after", "all", "an", "and", "another", "any", "as",
  "at", "be", "best", "but", "by", "choose", "content", "create", "draft", "each", "file",
  "find", "fit", "fits", "for", "from", "get", "give", "high", "i", "in",
  "into", "it", "keep", "make", "me", "model", "modeled", "modelling", "my",
  "its", "linkedin", "of", "on", "one", "original", "performing", "please", "post", "posts", "regular",
  "hook", "rewrite", "show", "source", "sources", "structure", "style", "swipe",
  "that", "the", "their", "them", "this", "to", "top", "topic", "use", "viral", "voice", "want", "with",
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

export type ModelingSourcePoolInput<T extends ModelingSourceCandidate> =
  ModelingSourceSelectionInput<T> & {
    // One replacement source per modeled-draft slot is sufficient for the
    // bounded 2-5 post batch. Clamp callers so selection can never turn an
    // accidental value into an unbounded response.
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

type RankedCandidate<T> = SelectedModelingSource<T> & {
  selectionIndex: number;
  selectionEligible: boolean;
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

function tokenizedTermsOf(value: unknown, maxChars: number): string[] {
  if (typeof value !== "string") return [];
  return (value
    .slice(0, maxChars)
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) ?? [])
    .map(normalizedTerm);
}

function lexicalTermsOf(value: unknown, maxChars: number): string[] {
  return tokenizedTermsOf(value, maxChars).filter((term) => term.length >= 2);
}

function isStopTerm(term: string): boolean {
  return (
    STOP_TERMS.has(term) ||
    (term.includes("-") &&
      term.split("-").every((component) => STOP_TERMS.has(component)))
  );
}

function termsOf(value: unknown, maxChars: number): string[] {
  const tokens = tokenizedTermsOf(value, maxChars);
  const terms: string[] = [];
  for (const term of tokens) {
    if (term.length < 2 || isStopTerm(term)) continue;
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
    if (isStopTerm(left) && isStopTerm(right)) continue;
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

function topicEligibilityAnchors(
  context: ModelingClientContext | undefined,
): Set<string> {
  const anchors = new Map<string, number>();
  addAnchors(anchors, context?.userInstruction, 1);
  addAnchorCollection(anchors, context?.voiceAnchors?.topics, 1);
  const topicTerms = new Set<string>();
  for (const anchor of anchors.keys()) {
    topicTerms.add(anchor);
    for (const component of anchor.split(" ")) {
      // `content` is intentionally a command stop word by itself, but becomes
      // topical inside phrases such as "content writing". Other stop words are
      // only grammatical glue and must never make an unrelated body eligible.
      if (!isStopTerm(component) || component === "content") {
        topicTerms.add(component);
      }
    }
  }
  return topicTerms;
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

function matchesTopicInBody(
  candidate: ModelingSourceCandidate,
  topicAnchors: ReadonlySet<string>,
): boolean {
  if (topicAnchors.size === 0) return true;
  const bodyTerms = new Set(
    lexicalTermsOf(candidate.text, MAX_CANDIDATE_TEXT_CHARS),
  );
  return [...topicAnchors].some((anchor) => bodyTerms.has(anchor));
}

function withoutSelectionMetadata<T extends ModelingSourceCandidate>(
  candidate: RankedCandidate<T>,
): SelectedModelingSource<T> {
  const selected = { ...candidate } as Record<string, unknown>;
  delete selected.selectionIndex;
  delete selected.selectionEligible;
  delete selected.selectionQuality;
  delete selected.selectionRejected;
  return selected as SelectedModelingSource<T>;
}

function rotateQualityPool<T>(
  ranked: RankedCandidate<T>[],
  cursor: number,
  limit: number,
): RankedCandidate<T>[] {
  let eligible = 0;
  const bestQuality = ranked[0]?.selectionQuality ?? 0;
  // Match the tools' bounded 6x over-fetch: equal-quality sources can all
  // rotate, while the tolerance prevents materially weaker sources from
  // entering the rotation merely because the pool is large.
  const maxPool = Math.max(limit + 1, limit * 6);
  while (
    eligible < ranked.length &&
    eligible < maxPool &&
    !ranked[eligible].already_used &&
    !ranked[eligible].recently_surfaced &&
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

function authorKey(candidate: ModelingSourceCandidate): string {
  const authorName = accountFields(candidate.accounts).name;
  return authorName || `unknown:${candidate.id}`;
}

function takeDiverse<T extends ModelingSourceCandidate>(
  candidates: RankedCandidate<T>[],
  limit: number,
  priorAuthors: ReadonlySet<string> = new Set(),
): {
  selected: RankedCandidate<T>[];
  remaining: RankedCandidate<T>[];
  selectedAuthors: Set<string>;
} {
  const selected: RankedCandidate<T>[] = [];
  const selectedIds = new Set<string>();
  const selectedAuthors = new Set(priorAuthors);

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const key = authorKey(candidate);
    if (selectedAuthors.has(key)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    selectedAuthors.add(key);
  }

  if (selected.length < limit) {
    for (const candidate of candidates) {
      if (selected.length >= limit) break;
      if (selectedIds.has(candidate.id)) continue;
      selected.push(candidate);
      selectedIds.add(candidate.id);
      selectedAuthors.add(authorKey(candidate));
    }
  }

  return {
    selected,
    remaining: candidates.filter((candidate) => !selectedIds.has(candidate.id)),
    selectedAuthors,
  };
}

/**
 * Deterministically chooses sources the system will model on the user's
 * behalf. Explicit analytical rankings and user-selected source ids must not
 * call this function; those are retrieval contracts, not selection problems.
 */
export function selectModelingSourcePool<T extends ModelingSourceCandidate>(
  input: ModelingSourcePoolInput<T>,
): ModelingSourcePool<T> {
  const requestedLimit = input.limit === Number.NEGATIVE_INFINITY
    ? 0
    : Number.isFinite(input.limit)
      ? Math.max(0, Math.floor(input.limit))
      : input.candidates.length;
  const limit = Math.min(MAX_SELECTION, requestedLimit);
  const requestedReserveLimit = Number.isFinite(input.reserveLimit)
    ? Math.max(0, Math.floor(input.reserveLimit ?? 0))
    : input.reserveLimit === Number.POSITIVE_INFINITY
      ? MAX_RESERVES
      : 0;
  const reserveLimit = Math.min(MAX_RESERVES, requestedReserveLimit);
  if (limit === 0 || input.candidates.length === 0) {
    return { primaries: [], reserves: [] };
  }

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
  const topicAnchors = topicEligibilityAnchors(input.clientContext);
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
        selectionEligible: matchesTopicInBody(candidate, topicAnchors),
        selectionRejected: modelability.reject !== null,
        selectionQuality: modelability.score * 0.65 + relevance * 0.35,
      };
    })
    .filter(
      (candidate) =>
        !candidate.selectionRejected && candidate.selectionEligible,
    )
    .sort((left, right) => {
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
  const primaryPool = takeDiverse(rotated, limit);
  const reservePool = takeDiverse(
    primaryPool.remaining,
    reserveLimit,
    primaryPool.selectedAuthors,
  );

  return {
    primaries: primaryPool.selected.map(withoutSelectionMetadata),
    reserves: reservePool.selected.map(withoutSelectionMetadata),
  };
}

/** Compatibility wrapper for callers that only consume primary selections. */
export function selectModelingSources<T extends ModelingSourceCandidate>(
  input: ModelingSourceSelectionInput<T>,
): Array<SelectedModelingSource<T>> {
  return selectModelingSourcePool({ ...input, reserveLimit: 0 }).primaries;
}
