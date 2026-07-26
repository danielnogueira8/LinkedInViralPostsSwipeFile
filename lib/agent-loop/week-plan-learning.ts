import type {
  LearningSignal,
  WorkspaceLearningModel,
} from "@/lib/content-learning/contracts";

export type WeekPlanLearningSource =
  WorkspaceLearningModel["sourceMode"];

const TOKEN_MIN_LENGTH = 3;
const MAX_SIGNALS_PER_KIND = 5;
const OPPORTUNITY_LEARNING_NUDGE_MAX = 0.35;

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "been",
  "before",
  "being",
  "but",
  "can",
  "did",
  "does",
  "for",
  "from",
  "have",
  "how",
  "into",
  "its",
  "just",
  "most",
  "not",
  "one",
  "only",
  "post",
  "posts",
  "share",
  "that",
  "the",
  "their",
  "this",
  "through",
  "today",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

const STYLE_CUES: ReadonlyArray<ReadonlySet<string>> = [
  new Set([
    "contrarian",
    "disagree",
    "doubt",
    "myth",
    "opposite",
    "rule",
    "unpopular",
    "wrong",
  ]),
  new Set([
    "case",
    "client",
    "failure",
    "lesson",
    "mistake",
    "moment",
    "story",
  ]),
  new Set([
    "checklist",
    "framework",
    "howto",
    "list",
    "process",
    "steps",
    "system",
    "workflow",
  ]),
  new Set([
    "claim",
    "direct",
    "opener",
    "question",
    "reversal",
    "statement",
  ]),
];

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) =>
        token.length > 4 && token.endsWith("s")
          ? token.slice(0, -1)
          : token,
      )
      .filter(
        (token) =>
          (token === "ai" || token.length >= TOKEN_MIN_LENGTH) &&
          !STOP_WORDS.has(token),
      ),
  );
}

function rankedGuidanceSignals(
  model: WorkspaceLearningModel | null | undefined,
): LearningSignal[] {
  if (!model || model.status !== "active") return [];
  const eligible = model.signals.filter(
    (signal) =>
      ["topic", "format", "hook"].includes(signal.kind) &&
      (model.sourceMode === "voice_exemplars" || signal.score > 0),
  );
  const grouped = new Map<LearningSignal["kind"], LearningSignal[]>();
  for (const signal of eligible) {
    const group = grouped.get(signal.kind) ?? [];
    group.push(signal);
    grouped.set(signal.kind, group);
  }
  return [...grouped.values()].flatMap((group) =>
    group
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.confidence - left.confidence ||
          right.sampleSize - left.sampleSize ||
          (left.label < right.label
            ? -1
            : left.label > right.label
              ? 1
              : 0),
      )
      .slice(0, MAX_SIGNALS_PER_KIND),
  );
}

function cueMatches(
  signalTokens: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
): number {
  let matches = 0;
  for (const cue of STYLE_CUES) {
    const signalHasCue = [...cue].some((token) =>
      signalTokens.has(token),
    );
    if (
      signalHasCue &&
      [...cue].some((token) => candidateTokens.has(token))
    ) {
      matches += 1;
    }
  }
  return matches;
}

export function weekPlanLearningAffinity(
  candidateText: string,
  model: WorkspaceLearningModel | null | undefined,
): number {
  const candidateTokens = tokens(candidateText);
  if (candidateTokens.size === 0) return 0;
  let affinity = 0;
  for (const signal of rankedGuidanceSignals(model)) {
    const signalTokens = tokens(signal.label);
    const overlap = [...signalTokens].filter((token) =>
      candidateTokens.has(token),
    ).length;
    const styleMatches =
      signal.kind === "topic"
        ? 0
        : cueMatches(signalTokens, candidateTokens);
    if (overlap === 0 && styleMatches === 0) continue;
    const evidenceWeight =
      model?.sourceMode === "voice_exemplars"
        ? Math.max(0.2, signal.confidence)
        : Math.max(0, signal.score) *
          Math.max(0.2, signal.confidence);
    const kindWeight =
      signal.kind === "topic" ? 1.5 : signal.kind === "hook" ? 1 : 0.8;
    affinity +=
      evidenceWeight *
      kindWeight *
      (overlap + styleMatches * 0.75);
  }
  return affinity;
}

export function weekPlanLearningSource(
  candidateText: string,
  model: WorkspaceLearningModel | null | undefined,
): WeekPlanLearningSource | null {
  return weekPlanLearningAffinity(candidateText, model) > 0
    ? (model?.sourceMode ?? null)
    : null;
}

export function rankWeekPlanOpportunities<
  T extends { sourceText: string },
>(
  candidates: readonly T[],
  model: WorkspaceLearningModel | null | undefined,
  options: { preserveStrongest?: boolean } = {},
): T[] {
  if (!model || model.status !== "active") return [...candidates];
  const preserveStrongest = options.preserveStrongest !== false;
  const strongest = preserveStrongest ? candidates[0] : undefined;
  const remaining = preserveStrongest
    ? candidates.slice(1)
    : [...candidates];
  if (remaining.length === 0) return strongest ? [strongest] : [];
  const denominator = Math.max(1, remaining.length);
  const reranked = remaining
    .map((candidate, index) => {
      const baseScore = (remaining.length - index) / denominator;
      const learningNudge = Math.min(
        OPPORTUNITY_LEARNING_NUDGE_MAX,
        weekPlanLearningAffinity(candidate.sourceText, model) * 0.15,
      );
      return { candidate, index, score: baseScore + learningNudge };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.index - right.index,
    )
    .map(({ candidate }) => candidate);
  return strongest ? [strongest, ...reranked] : reranked;
}

export function rankGenericWeekPrompts(
  prompts: readonly string[],
  model: WorkspaceLearningModel | null | undefined,
): string[] {
  if (!model || model.status !== "active") return [...prompts];
  return prompts
    .map((prompt, index) => ({
      prompt,
      index,
      affinity: weekPlanLearningAffinity(prompt, model),
    }))
    .sort(
      (left, right) =>
        right.affinity - left.affinity || left.index - right.index,
    )
    .map(({ prompt }) => prompt);
}
