export const COWORK_CRITICAL_JOURNEYS = [
  "original_post",
  "refine",
  "fixed_source",
  "partial",
  "multi_post",
  "no_search",
  "research_write",
  "saved_draft_action",
  "clarification_completion",
  "fresh_news_fail_closed",
  "cancellation",
  "retry_recovery",
] as const;

export const COWORK_WRITING_CLASSES = [
  "original",
  "refine",
  "fixed_source",
  "partial",
  "multi_post",
  "research_write",
] as const;

export type CoworkCriticalJourney = (typeof COWORK_CRITICAL_JOURNEYS)[number];
export type CoworkWritingClass = (typeof COWORK_WRITING_CLASSES)[number];
export type CoworkArchitecture = "baseline" | "v2";
type EvidenceTerminalOutcome =
  | "delivered"
  | "clarified"
  | "cancelled"
  | "recoverable_error"
  | "hard_failure";

export type CoworkEvidenceRun = {
  runId: string;
  architecture: CoworkArchitecture;
  journey: CoworkCriticalJourney;
  variantId: string;
  modelComparisonGroup?: string;
  evidenceSource: "scripted" | "live";
  productionShaped: boolean;
  costObserved: boolean;
  contractPassed: boolean;
  terminalOutcome: EvidenceTerminalOutcome;
  fallbackUsed: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  chargedCostUsd: number;
  orchestratorModel?: string;
  writerModel?: string;
};

export type CoworkQualityScores = {
  usefulness: number;
  voice: number;
  factuality: number;
  completeness: number;
};

export type CoworkBlindCandidate = {
  candidateId: string;
  architecture: CoworkArchitecture;
  orchestratorModel?: string;
  writerModel?: string;
  scores: CoworkQualityScores;
};

export type CoworkBlindComparison = {
  comparisonId: string;
  comparisonKind: "architecture" | "writer_model";
  writingClass: CoworkWritingClass;
  blind: true;
  candidates: [CoworkBlindCandidate, CoworkBlindCandidate];
  preferredCandidateId: string | "tie";
};

type MetricValue = { total: number; average: number };

export type CoworkRunMetrics = {
  runs: number;
  productionShapedRuns: number;
  completedProductionShapedRuns: number;
  observedChargedCostRuns: number;
  contractPassRate: number;
  hardFailures: number;
  hardFailureRate: number;
  fallbacks: number;
  fallbackRate: number;
  latencyMs: { p50: number; p95: number; p99: number };
  tokens: {
    input: MetricValue;
    output: MetricValue;
    reasoning: MetricValue;
    cachedInput: MetricValue;
  };
  chargedCostUsd: MetricValue;
};

type QualityDimensions = CoworkQualityScores & { preferenceRate: number };

export type CoworkQualityClassReport = {
  comparisons: number;
  baseline: QualityDimensions;
  v2: QualityDimensions;
};

type ModelCandidateReport = {
  model: string;
  runs: CoworkRunMetrics;
  blindComparisons: number;
  blindComparisonsByWritingClass: Record<CoworkWritingClass, number>;
  qualityScore: number | null;
};

type ModelRecommendation =
  | {
      status: "insufficient_evidence";
      order: [];
      requiredRunsPerCandidate: number;
      requiredBlindComparisonsPerWriter: number;
      candidates: ModelCandidateReport[];
    }
  | {
      status: "measured";
      order: string[];
      requiredRunsPerCandidate: number;
      requiredBlindComparisonsPerWriter: number;
      candidates: ModelCandidateReport[];
    };

export type CoworkRolloutEvidenceReport = {
  schemaVersion: 2;
  runs: {
    overall: CoworkRunMetrics;
    byJourney: Record<CoworkCriticalJourney, CoworkRunMetrics>;
    byVariant: Record<string, CoworkRunMetrics>;
    byArchitectureAndJourney: Record<
      CoworkArchitecture,
      Record<CoworkCriticalJourney, CoworkRunMetrics>
    >;
    byLiveArchitectureAndJourney: Record<
      CoworkArchitecture,
      Record<CoworkCriticalJourney, CoworkRunMetrics>
    >;
  };
  quality: {
    byWritingClass: Record<CoworkWritingClass, CoworkQualityClassReport>;
  };
  modelRecommendations: {
    orchestrator: ModelRecommendation;
    writer: ModelRecommendation;
  };
  browserValidation: {
    desktop: "passed" | "failed" | "pending";
    mobile: "passed" | "failed" | "pending";
  };
  promotion: {
    status: "passed" | "blocked";
    blockers: string[];
  };
};

const MINIMUM_RUNS = 300;
const MINIMUM_BLIND_COMPARISONS = 20;
const MODEL_CANDIDATES = {
  orchestrator: [
    "anthropic/claude-sonnet-5",
    "google/gemini-3.5-flash",
  ],
  writer: ["qwen/qwen3.7-plus", "z-ai/glm-5.2"],
} as const;

function safeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function average(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + safeNumber(value), 0) / values.length;
}

function metric(values: readonly number[]): MetricValue {
  const total = values.reduce((sum, value) => sum + safeNumber(value), 0);
  return {
    total: Number(total.toFixed(8)),
    average: values.length ? Number((total / values.length).toFixed(8)) : 0,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = values.map(safeNumber).sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function isCompletedProductionShapedRun(run: CoworkEvidenceRun): boolean {
  if (!run.productionShaped || !run.contractPassed) return false;
  if (run.journey === "cancellation") {
    return run.terminalOutcome === "cancelled";
  }
  if (run.journey === "fresh_news_fail_closed") {
    return (
      run.terminalOutcome === "clarified" ||
      run.terminalOutcome === "recoverable_error"
    );
  }
  return run.terminalOutcome === "delivered";
}

export function summarizeCoworkEvidenceRuns(
  runs: readonly CoworkEvidenceRun[],
): CoworkRunMetrics {
  const hardFailures = runs.filter(
    (run) => run.terminalOutcome === "hard_failure",
  ).length;
  const fallbacks = runs.filter((run) => run.fallbackUsed).length;
  const count = runs.length;
  return {
    runs: count,
    productionShapedRuns: runs.filter((run) => run.productionShaped).length,
    completedProductionShapedRuns: runs.filter(isCompletedProductionShapedRun)
      .length,
    observedChargedCostRuns: runs.filter(
      (run) => run.evidenceSource === "live" && run.costObserved,
    ).length,
    contractPassRate: count
      ? runs.filter((run) => run.contractPassed).length / count
      : 0,
    hardFailures,
    hardFailureRate: count ? hardFailures / count : 0,
    fallbacks,
    fallbackRate: count ? fallbacks / count : 0,
    latencyMs: {
      p50: percentile(runs.map((run) => run.latencyMs), 0.5),
      p95: percentile(runs.map((run) => run.latencyMs), 0.95),
      p99: percentile(runs.map((run) => run.latencyMs), 0.99),
    },
    tokens: {
      input: metric(runs.map((run) => run.inputTokens)),
      output: metric(runs.map((run) => run.outputTokens)),
      reasoning: metric(runs.map((run) => run.reasoningTokens)),
      cachedInput: metric(runs.map((run) => run.cachedInputTokens)),
    },
    chargedCostUsd: metric(
      runs
        .filter((run) => run.evidenceSource === "live" && run.costObserved)
        .map((run) => run.chargedCostUsd),
    ),
  };
}

function candidatesByArchitecture(
  comparison: CoworkBlindComparison,
): Record<CoworkArchitecture, CoworkBlindCandidate> | null {
  if (!comparison.blind || comparison.comparisonKind !== "architecture") {
    return null;
  }
  const baseline = comparison.candidates.find(
    (candidate) => candidate.architecture === "baseline",
  );
  const v2 = comparison.candidates.find(
    (candidate) => candidate.architecture === "v2",
  );
  return baseline && v2 ? { baseline, v2 } : null;
}

function emptyQuality(): QualityDimensions {
  return {
    usefulness: 0,
    voice: 0,
    factuality: 0,
    completeness: 0,
    preferenceRate: 0,
  };
}

function summarizeQualityClass(
  comparisons: readonly CoworkBlindComparison[],
): CoworkQualityClassReport {
  const valid = comparisons.flatMap((comparison) => {
    const candidates = candidatesByArchitecture(comparison);
    return candidates ? [{ comparison, candidates }] : [];
  });
  const summarize = (architecture: CoworkArchitecture): QualityDimensions => {
    if (!valid.length) return emptyQuality();
    return {
      usefulness: average(
        valid.map(({ candidates }) => candidates[architecture].scores.usefulness),
      ),
      voice: average(
        valid.map(({ candidates }) => candidates[architecture].scores.voice),
      ),
      factuality: average(
        valid.map(({ candidates }) => candidates[architecture].scores.factuality),
      ),
      completeness: average(
        valid.map(({ candidates }) => candidates[architecture].scores.completeness),
      ),
      preferenceRate: average(
        valid.map(({ comparison, candidates }) =>
          comparison.preferredCandidateId === "tie"
            ? 0.5
            : comparison.preferredCandidateId ===
                candidates[architecture].candidateId
              ? 1
              : 0,
        ),
      ),
    };
  };
  return {
    comparisons: valid.length,
    baseline: summarize("baseline"),
    v2: summarize("v2"),
  };
}

function modelQuality(
  model: string,
  comparisons: readonly CoworkBlindComparison[],
): {
  count: number;
  byWritingClass: Record<CoworkWritingClass, number>;
  score: number | null;
} {
  const scored = comparisons.flatMap((comparison) => {
    if (!comparison.blind || comparison.comparisonKind !== "writer_model") {
      return [];
    }
    if (
      !MODEL_CANDIDATES.writer.every((candidateModel) =>
        comparison.candidates.some(
          (candidate) => candidate.writerModel === candidateModel,
        ),
      )
    ) {
      return [];
    }
    if (
      new Set(
        comparison.candidates.map(
          (candidate) => candidate.orchestratorModel ?? "direct",
        ),
      ).size !== 1
    ) {
      return [];
    }
    const candidate = comparison.candidates.find(
      (item) => item.writerModel === model,
    );
    if (!candidate) return [];
    const preference =
      comparison.preferredCandidateId === "tie"
        ? 0.5
        : comparison.preferredCandidateId === candidate.candidateId
          ? 1
          : 0;
    return [
      average([
        candidate.scores.usefulness / 5,
        candidate.scores.voice / 5,
        candidate.scores.factuality / 5,
        candidate.scores.completeness / 5,
        preference,
      ]),
    ];
  });
  const byWritingClass = Object.fromEntries(
    COWORK_WRITING_CLASSES.map((writingClass) => [
      writingClass,
      comparisons.filter(
        (comparison) =>
          comparison.writingClass === writingClass &&
          comparison.blind &&
          comparison.comparisonKind === "writer_model" &&
          MODEL_CANDIDATES.writer.every((candidateModel) =>
            comparison.candidates.some(
              (candidate) => candidate.writerModel === candidateModel,
            ),
          ) &&
          new Set(
            comparison.candidates.map(
              (candidate) => candidate.orchestratorModel ?? "direct",
            ),
          ).size === 1 &&
          comparison.candidates.some((candidate) => candidate.writerModel === model),
      ).length,
    ]),
  ) as Record<CoworkWritingClass, number>;
  return {
    count: scored.length,
    byWritingClass,
    score: scored.length ? average(scored) : null,
  };
}

function matchedModelRuns(
  kind: "orchestrator" | "writer",
  runs: readonly CoworkEvidenceRun[],
): Record<string, CoworkEvidenceRun[]> {
  const candidates = MODEL_CANDIDATES[kind];
  const eligible = runs.filter(
    (run) =>
      run.architecture === "v2" &&
      run.evidenceSource === "live" &&
      run.productionShaped &&
      Boolean(run.modelComparisonGroup) &&
      candidates.includes(
        (kind === "orchestrator"
          ? run.orchestratorModel
          : run.writerModel) as never,
      ),
  );
  const strata = new Map<string, CoworkEvidenceRun[]>();
  for (const run of eligible) {
    const controlModel =
      kind === "orchestrator"
        ? run.writerModel
        : run.orchestratorModel ?? "direct";
    if (!controlModel) continue;
    const key = `${run.modelComparisonGroup}:${run.journey}:${controlModel}`;
    const stratum = strata.get(key) ?? [];
    stratum.push(run);
    strata.set(key, stratum);
  }
  const matched = Object.fromEntries(
    candidates.map((model) => [model, [] as CoworkEvidenceRun[]]),
  ) as Record<string, CoworkEvidenceRun[]>;
  for (const stratum of strata.values()) {
    const byCandidate = new Map<string, CoworkEvidenceRun[]>(
      candidates.map(
        (model) =>
          [
            model,
            stratum.filter((run) =>
              kind === "orchestrator"
                ? run.orchestratorModel === model
                : run.writerModel === model,
            ),
          ] as const,
      ),
    );
    if (
      candidates.every(
        (model) =>
          (byCandidate.get(model) ?? []).filter(
            (run) => run.costObserved && isCompletedProductionShapedRun(run),
          ).length >= MINIMUM_RUNS,
      )
    ) {
      for (const model of candidates) {
        matched[model].push(...(byCandidate.get(model) ?? []));
      }
    }
  }
  return matched;
}

function modelRecommendation(
  kind: "orchestrator" | "writer",
  runs: readonly CoworkEvidenceRun[],
  comparisons: readonly CoworkBlindComparison[],
): ModelRecommendation {
  const matchedRuns = matchedModelRuns(kind, runs);
  const candidates = MODEL_CANDIDATES[kind].map((model) => {
    const modelRuns = matchedRuns[model] ?? [];
    const quality =
      kind === "writer"
        ? modelQuality(model, comparisons)
        : {
            count: 0,
            byWritingClass: Object.fromEntries(
              COWORK_WRITING_CLASSES.map((writingClass) => [writingClass, 0]),
            ) as Record<CoworkWritingClass, number>,
            score: null,
          };
    return {
      model,
      runs: summarizeCoworkEvidenceRuns(modelRuns),
      blindComparisons: quality.count,
      blindComparisonsByWritingClass: quality.byWritingClass,
      qualityScore: quality.score,
    };
  });
  const enoughEvidence = candidates.every(
    (candidate) =>
      candidate.runs.completedProductionShapedRuns >= MINIMUM_RUNS &&
      (kind === "orchestrator" ||
        COWORK_WRITING_CLASSES.every(
          (writingClass) =>
            candidate.blindComparisonsByWritingClass[writingClass] >=
            MINIMUM_BLIND_COMPARISONS,
        )),
  );
  const common = {
    requiredRunsPerCandidate: MINIMUM_RUNS,
    requiredBlindComparisonsPerWriter: MINIMUM_BLIND_COMPARISONS,
    candidates,
  };
  if (!enoughEvidence) {
    return { status: "insufficient_evidence", order: [], ...common };
  }
  const ordered = [...candidates].sort((left, right) => {
    const reliability =
      left.runs.hardFailureRate - right.runs.hardFailureRate ||
      right.runs.contractPassRate - left.runs.contractPassRate;
    if (reliability) return reliability;
    if (kind === "writer") {
      const quality =
        (right.qualityScore ?? Number.NEGATIVE_INFINITY) -
        (left.qualityScore ?? Number.NEGATIVE_INFINITY);
      if (quality) return quality;
    }
    return (
      left.runs.fallbackRate - right.runs.fallbackRate ||
      left.runs.latencyMs.p95 - right.runs.latencyMs.p95 ||
      left.runs.chargedCostUsd.average - right.runs.chargedCostUsd.average ||
      left.model.localeCompare(right.model)
    );
  });
  return {
    status: "measured",
    order: ordered.map((candidate) => candidate.model),
    ...common,
  };
}

function promotionBlockers(
  productionByArchitectureAndJourney: CoworkRolloutEvidenceReport["runs"]["byArchitectureAndJourney"],
  liveByArchitectureAndJourney: CoworkRolloutEvidenceReport["runs"]["byLiveArchitectureAndJourney"],
  quality: CoworkRolloutEvidenceReport["quality"],
  modelRecommendations: CoworkRolloutEvidenceReport["modelRecommendations"],
  browserValidation: CoworkRolloutEvidenceReport["browserValidation"],
): string[] {
  const blockers: string[] = [];
  const epsilon = 1e-12;
  for (const journey of COWORK_CRITICAL_JOURNEYS) {
    const baseline = liveByArchitectureAndJourney.baseline[journey];
    const v2 = liveByArchitectureAndJourney.v2[journey];
    const productionV2 = productionByArchitectureAndJourney.v2[journey];
    if (v2.completedProductionShapedRuns < MINIMUM_RUNS) {
      blockers.push(`${journey}:v2_runs_below_${MINIMUM_RUNS}`);
    }
    if (baseline.completedProductionShapedRuns < MINIMUM_RUNS) {
      blockers.push(`${journey}:baseline_runs_below_${MINIMUM_RUNS}`);
    }
    if (v2.observedChargedCostRuns < MINIMUM_RUNS) {
      blockers.push(`${journey}:v2_observed_cost_runs_below_${MINIMUM_RUNS}`);
    }
    if (baseline.observedChargedCostRuns < MINIMUM_RUNS) {
      blockers.push(
        `${journey}:baseline_observed_cost_runs_below_${MINIMUM_RUNS}`,
      );
    }
    if (productionV2.hardFailures > 0) {
      blockers.push(`${journey}:v2_hard_failures`);
    }
    if (
      v2.completedProductionShapedRuns < MINIMUM_RUNS ||
      baseline.completedProductionShapedRuns < MINIMUM_RUNS
    ) {
      continue;
    }
    if (v2.contractPassRate + epsilon < baseline.contractPassRate) {
      blockers.push(`${journey}:contract_regression`);
    }
    if (v2.fallbackRate > baseline.fallbackRate + epsilon) {
      blockers.push(`${journey}:fallback_regression`);
    }
    const directJourney = ![
      "research_write",
      "saved_draft_action",
      "fresh_news_fail_closed",
      "retry_recovery",
    ].includes(journey);
    const p95Target = directJourney ? 30_000 : 60_000;
    if (v2.latencyMs.p95 > p95Target) {
      blockers.push(`${journey}:p95_above_${p95Target}ms`);
    }
    if (!directJourney && v2.latencyMs.p99 > 90_000) {
      blockers.push(`${journey}:p99_above_90000ms`);
    }
    if (v2.latencyMs.p95 > baseline.latencyMs.p95) {
      blockers.push(`${journey}:latency_regression`);
    }
    if (
      v2.chargedCostUsd.average >
      baseline.chargedCostUsd.average + epsilon
    ) {
      blockers.push(`${journey}:cost_regression`);
    }
  }

  const dimensions = [
    "usefulness",
    "voice",
    "factuality",
    "completeness",
    "preferenceRate",
  ] as const;
  for (const writingClass of COWORK_WRITING_CLASSES) {
    const report = quality.byWritingClass[writingClass];
    if (report.comparisons < MINIMUM_BLIND_COMPARISONS) {
      blockers.push(
        `${writingClass}:blind_comparisons_below_${MINIMUM_BLIND_COMPARISONS}`,
      );
      continue;
    }
    for (const dimension of dimensions) {
      if (report.v2[dimension] + epsilon < report.baseline[dimension]) {
        blockers.push(
          `${writingClass}:${
            dimension === "preferenceRate" ? "preference" : dimension
          }_regression`,
        );
      }
    }
  }
  if (modelRecommendations.orchestrator.status !== "measured") {
    blockers.push("model_order:orchestrator_insufficient_evidence");
  }
  if (modelRecommendations.writer.status !== "measured") {
    blockers.push("model_order:writer_insufficient_evidence");
  }
  if (browserValidation.desktop !== "passed") {
    blockers.push(`browser:desktop_${browserValidation.desktop}`);
  }
  if (browserValidation.mobile !== "passed") {
    blockers.push(`browser:mobile_${browserValidation.mobile}`);
  }
  return blockers;
}

export function buildCoworkRolloutEvidence(input: {
  runs: readonly CoworkEvidenceRun[];
  blindComparisons: readonly CoworkBlindComparison[];
  browserValidation?: CoworkRolloutEvidenceReport["browserValidation"];
}): CoworkRolloutEvidenceReport {
  const byJourney = Object.fromEntries(
    COWORK_CRITICAL_JOURNEYS.map((journey) => [
      journey,
      summarizeCoworkEvidenceRuns(input.runs.filter((run) => run.journey === journey)),
    ]),
  ) as Record<CoworkCriticalJourney, CoworkRunMetrics>;
  const variants = [...new Set(input.runs.map((run) => run.variantId))].sort();
  const byVariant = Object.fromEntries(
    variants.map((variant) => [
      variant,
      summarizeCoworkEvidenceRuns(
        input.runs.filter((run) => run.variantId === variant),
      ),
    ]),
  );
  const byArchitectureAndJourney = Object.fromEntries(
    (["baseline", "v2"] as const).map((architecture) => [
      architecture,
      Object.fromEntries(
        COWORK_CRITICAL_JOURNEYS.map((journey) => [
          journey,
          summarizeCoworkEvidenceRuns(
            input.runs.filter(
              (run) =>
                run.productionShaped &&
                run.architecture === architecture &&
                run.journey === journey,
            ),
          ),
        ]),
      ),
    ]),
  ) as CoworkRolloutEvidenceReport["runs"]["byArchitectureAndJourney"];
  const byLiveArchitectureAndJourney = Object.fromEntries(
    (["baseline", "v2"] as const).map((architecture) => [
      architecture,
      Object.fromEntries(
        COWORK_CRITICAL_JOURNEYS.map((journey) => [
          journey,
          summarizeCoworkEvidenceRuns(
            input.runs.filter(
              (run) =>
                run.productionShaped &&
                run.evidenceSource === "live" &&
                run.architecture === architecture &&
                run.journey === journey,
            ),
          ),
        ]),
      ),
    ]),
  ) as CoworkRolloutEvidenceReport["runs"]["byLiveArchitectureAndJourney"];
  const quality = {
    byWritingClass: Object.fromEntries(
      COWORK_WRITING_CLASSES.map((writingClass) => [
        writingClass,
        summarizeQualityClass(
          input.blindComparisons.filter(
            (comparison) => comparison.writingClass === writingClass,
          ),
        ),
      ]),
    ) as Record<CoworkWritingClass, CoworkQualityClassReport>,
  };
  const browserValidation = input.browserValidation ?? {
    desktop: "pending",
    mobile: "pending",
  };
  const modelRecommendations = {
    orchestrator: modelRecommendation(
      "orchestrator",
      input.runs,
      input.blindComparisons,
    ),
    writer: modelRecommendation("writer", input.runs, input.blindComparisons),
  };
  const blockers = promotionBlockers(
    byArchitectureAndJourney,
    byLiveArchitectureAndJourney,
    quality,
    modelRecommendations,
    browserValidation,
  );

  return {
    schemaVersion: 2,
    runs: {
      overall: summarizeCoworkEvidenceRuns(input.runs),
      byJourney,
      byVariant,
      byArchitectureAndJourney,
      byLiveArchitectureAndJourney,
    },
    quality,
    modelRecommendations,
    browserValidation,
    promotion: {
      status: blockers.length ? "blocked" : "passed",
      blockers,
    },
  };
}
