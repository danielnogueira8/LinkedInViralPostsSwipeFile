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
  const proposals = new Map<string, RefinedOpportunity[]>();
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
    if (!headline || !angle || !viralMechanism) continue;
    const quality = input.qualityFor({
      candidate,
      headline,
      angle,
      model: row.quality,
    });
    if (!quality) continue;
    const existing = proposals.get(id) ?? [];
    existing.push({ headline, angle, viralMechanism, score: quality.score });
    proposals.set(id, existing);
  }

  const selected = new Map<string, RefinedOpportunity>();
  for (const [id, options] of proposals) {
    const diverse = [...options]
      .sort((left, right) => right.score - left.score)
      .reduce<RefinedOpportunity[]>((kept, option) => {
        if (
          kept.every((existing) =>
            areDistinctOpportunityAngles(existing.angle, option.angle),
          )
        ) {
          kept.push(option);
        }
        return kept;
      }, []);
    if (diverse.length >= 2 && diverse[0]) selected.set(id, diverse[0]);
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
