export const OPPORTUNITY_QUALITY_WEIGHTS = {
  relevance: 0.25,
  tension: 0.2,
  evidence: 0.2,
  novelty: 0.15,
  timeliness: 0.1,
  shareability: 0.1,
} as const;

export type OpportunityQualityDimensions = {
  relevance: number;
  tension: number;
  evidence: number;
  novelty: number;
  timeliness: number;
  shareability: number;
};

export type ModelOpportunityQuality = Omit<
  OpportunityQualityDimensions,
  "evidence"
>;

export const MODEL_OPPORTUNITY_QUALITY_JSON_SCHEMA = {
  type: "object",
  properties: {
    relevance: { type: "number", minimum: 0, maximum: 1 },
    tension: { type: "number", minimum: 0, maximum: 1 },
    novelty: { type: "number", minimum: 0, maximum: 1 },
    timeliness: { type: "number", minimum: 0, maximum: 1 },
    shareability: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["relevance", "tension", "novelty", "timeliness", "shareability"],
} as const;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rating(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value)
    : null;
}

export function readModelOpportunityQuality(
  value: unknown,
): ModelOpportunityQuality | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const relevance = rating(row.relevance);
  const tension = rating(row.tension);
  const novelty = rating(row.novelty);
  const timeliness = rating(row.timeliness);
  const shareability = rating(row.shareability);
  if (
    relevance === null ||
    tension === null ||
    novelty === null ||
    timeliness === null ||
    shareability === null
  ) {
    return null;
  }
  return { relevance, tension, novelty, timeliness, shareability };
}

function normalizedTerms(topics: readonly string[]): string[] {
  return [
    ...new Set(
      topics
        .flatMap((topic) => topic.toLocaleLowerCase("en-US").split(/\s+/))
        .map((term) => term.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter((term) => term.length >= 3),
    ),
  ];
}

/**
 * A small deterministic relevance check keeps a model from assigning a high
 * audience-fit score to an idea with no visible relationship to the user's
 * chosen topics. Empty topic preferences stay neutral because the synthesis
 * prompt is then expected to infer fit from approved evidence.
 */
export function topicRelevance(
  topics: readonly string[],
  ...content: string[]
): number {
  const terms = normalizedTerms(topics);
  if (terms.length === 0) return 0.65;
  const haystack = content.join(" ").toLocaleLowerCase("en-US");
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return clamp(0.2 + matches / Math.min(4, terms.length));
}

export function scoreOpportunityQuality(input: {
  model: ModelOpportunityQuality;
  evidence: number;
  topicFit: number;
}): { score: number; dimensions: OpportunityQualityDimensions } {
  const dimensions: OpportunityQualityDimensions = {
    ...input.model,
    // Audience relevance is mostly semantic model judgment, but topic overlap
    // provides an independent guard against attractive yet off-topic ideas.
    relevance: clamp(input.model.relevance * 0.7 + input.topicFit * 0.3),
    evidence: clamp(input.evidence),
  };
  const score = Object.entries(OPPORTUNITY_QUALITY_WEIGHTS).reduce(
    (total, [key, weight]) =>
      total + dimensions[key as keyof OpportunityQualityDimensions] * weight,
    0,
  );
  return { score: Number(clamp(score).toFixed(4)), dimensions };
}

export function isStrongOpportunity(input: {
  score: number;
  dimensions: OpportunityQualityDimensions;
}): boolean {
  const { dimensions } = input;
  return (
    input.score >= 0.55 &&
    dimensions.evidence >= 0.5 &&
    dimensions.relevance >= 0.45 &&
    Math.max(dimensions.tension, dimensions.shareability) >= 0.45
  );
}

export function evaluateModelOpportunityQuality(input: {
  model: unknown;
  evidence: number;
  topicFit: number;
}): ReturnType<typeof scoreOpportunityQuality> | null {
  const model = readModelOpportunityQuality(input.model);
  if (!model) return null;
  const quality = scoreOpportunityQuality({
    model,
    evidence: input.evidence,
    topicFit: input.topicFit,
  });
  return isStrongOpportunity(quality) ? quality : null;
}

export type RefinedOpportunity = {
  headline: string;
  angle: string;
  viralMechanism: string;
  score: number;
};

export const OPPORTUNITY_ANGLE_CATEGORIES = [
  "changed_incentive",
  "unexpected_consequence",
  "contrarian_belief",
  "decision_rule",
  "identity_tension",
  "proof_gap",
] as const;
export type OpportunityAngleCategory =
  (typeof OPPORTUNITY_ANGLE_CATEGORIES)[number];
export const OPPORTUNITY_ANGLE_CATEGORY_JSON_SCHEMA = {
  type: "string",
  enum: OPPORTUNITY_ANGLE_CATEGORIES,
} as const;
export const OPPORTUNITY_ANGLE_CATEGORY_GUIDANCE = [
  "changed_incentive: a concrete behavior is newly rewarded or punished",
  "unexpected_consequence: a second-order outcome follows from the signal",
  "contrarian_belief: the evidence challenges a common belief",
  "decision_rule: the audience gets a threshold or choice rule",
  "identity_tension: the signal conflicts with how the audience sees itself",
  "proof_gap: the signal exposes a claim that lacks evidence",
].join("; ");

function readAngleCategory(value: unknown): OpportunityAngleCategory | null {
  return typeof value === "string" &&
    (OPPORTUNITY_ANGLE_CATEGORIES as readonly string[]).includes(value)
    ? (value as OpportunityAngleCategory)
    : null;
}

const ANGLE_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "because",
  "from",
  "have",
  "into",
  "that",
  "their",
  "this",
  "through",
  "what",
  "when",
  "where",
  "which",
  "with",
  "your",
]);

function meaningfulAngleTerms(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("en-US")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 4 && !ANGLE_STOP_WORDS.has(term)),
  );
}

export function areDistinctOpportunityAngles(
  left: string,
  right: string,
): boolean {
  const leftTerms = meaningfulAngleTerms(left);
  const rightTerms = meaningfulAngleTerms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) return false;
  const shared = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  const similarity = shared / Math.min(leftTerms.size, rightTerms.size);
  return similarity < 0.7;
}

function cleanRefinedField(value: unknown, max: number): string {
  return truncateAtWordBoundary(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}

export function hasInvalidRefinedAngleCategories<C>(input: {
  rows: unknown;
  candidates: ReadonlyMap<string, C>;
}): boolean {
  if (!Array.isArray(input.rows)) return false;
  return input.rows.some((value) => {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    const id = cleanRefinedField(row.candidate_id, 240);
    return input.candidates.has(id) && !readAngleCategory(row.angle_category);
  });
}

/**
 * Applies the common model-output boundary for Trend Radar and Newsjacking:
 * known candidate, complete proposal, quality gate, semantic diversity, then
 * highest-score selection. Keeping this policy shared prevents the two agent
 * paths from silently drifting apart.
 */
export function collectDistinctRefinedOpportunities<C>(input: {
  rows: unknown;
  candidates: ReadonlyMap<string, C>;
  qualityFor: (input: {
    candidate: C;
    headline: string;
    angle: string;
    model: unknown;
  }) => ReturnType<typeof scoreOpportunityQuality> | null;
}): Map<string, RefinedOpportunity> {
  const proposals = new Map<
    string,
    Array<RefinedOpportunity & { angleCategory: OpportunityAngleCategory }>
  >();
  const rows = Array.isArray(input.rows) ? input.rows : [];
  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const id = cleanRefinedField(row.candidate_id, 240);
    const candidate = input.candidates.get(id);
    if (!candidate) continue;
    const headline = cleanRefinedField(row.headline, 140);
    const angle = cleanRefinedField(row.thesis, 700);
    const viralMechanism = cleanRefinedField(row.viral_mechanism, 220);
    const angleCategory = readAngleCategory(row.angle_category);
    if (!headline || !angle || !viralMechanism || !angleCategory) continue;
    const quality = input.qualityFor({
      candidate,
      headline,
      angle,
      model: row.quality,
    });
    if (!quality) continue;
    const existing = proposals.get(id) ?? [];
    existing.push({
      headline,
      angle,
      viralMechanism,
      score: quality.score,
      angleCategory,
    });
    proposals.set(id, existing);
  }

  const selected = new Map<string, RefinedOpportunity>();
  for (const [id, options] of proposals) {
    const pairs = options.flatMap((left, leftIndex) =>
      options.slice(leftIndex + 1).flatMap((right) =>
        left.angleCategory !== right.angleCategory &&
        areDistinctOpportunityAngles(left.angle, right.angle)
          ? [{ left, right, combinedScore: left.score + right.score }]
          : [],
      ),
    );
    const bestPair = pairs.sort(
      (left, right) => right.combinedScore - left.combinedScore,
    )[0];
    if (bestPair) {
      const strongest =
        bestPair.left.score >= bestPair.right.score
          ? bestPair.left
          : bestPair.right;
      const { headline, angle, viralMechanism, score } = strongest;
      selected.set(id, { headline, angle, viralMechanism, score });
    }
  }
  return selected;
}

export function selectRefinedCandidates<C>(input: {
  candidates: readonly C[];
  opportunities: ReadonlyMap<string, { score: number }>;
  key: (candidate: C) => string;
  limit: number;
}): C[] {
  return input.candidates
    .filter((candidate) => input.opportunities.has(input.key(candidate)))
    .sort(
      (left, right) =>
        (input.opportunities.get(input.key(right))?.score ?? 0) -
        (input.opportunities.get(input.key(left))?.score ?? 0),
    )
    .slice(0, input.limit);
}
import { truncateAtWordBoundary } from "@/lib/text-truncate";
