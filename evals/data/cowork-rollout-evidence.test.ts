import { describe, expect, test } from "vitest";
import {
  buildCoworkRolloutEvidence,
  COWORK_CRITICAL_JOURNEYS,
  COWORK_WRITING_CLASSES,
  type CoworkBlindComparison,
  type CoworkEvidenceRun,
} from "@/lib/agent/cowork-rollout-evidence";

function run(
  architecture: "baseline" | "v2",
  journey: CoworkEvidenceRun["journey"],
  index: number,
  overrides: Partial<CoworkEvidenceRun> = {},
): CoworkEvidenceRun {
  return {
    runId: `${architecture}-${journey}-${index}`,
    architecture,
    journey,
    variantId: architecture === "baseline" ? "legacy-glm" : "v2-qwen",
    evidenceSource: "live",
    productionShaped: true,
    costObserved: true,
    contractPassed: true,
    terminalOutcome:
      journey === "cancellation"
        ? "cancelled"
        : journey === "fresh_news_fail_closed"
          ? "clarified"
          : "delivered",
    fallbackUsed: false,
    latencyMs: journey === "research_write" ? 20_000 : 8_000,
    inputTokens: 1_000,
    outputTokens: 300,
    reasoningTokens: architecture === "baseline" ? 100 : 0,
    cachedInputTokens: 200,
    chargedCostUsd: architecture === "baseline" ? 0.02 : 0.01,
    writerModel:
      architecture === "baseline" ? "z-ai/glm-5.2" : "qwen/qwen3.7-plus",
    ...(journey === "research_write" || journey === "saved_draft_action"
      ? {
          orchestratorModel:
            architecture === "baseline"
              ? "z-ai/glm-5.2"
              : "anthropic/claude-sonnet-5",
        }
      : {}),
    ...overrides,
  };
}

function comparison(
  writingClass: CoworkBlindComparison["writingClass"],
  index: number,
  overrides: Partial<CoworkBlindComparison> = {},
): CoworkBlindComparison {
  return {
    comparisonId: `${writingClass}-${index}`,
    comparisonKind: "architecture",
    writingClass,
    blind: true,
    candidates: [
      {
        candidateId: "candidate-a",
        architecture: "baseline",
        writerModel: "z-ai/glm-5.2",
        scores: { usefulness: 4, voice: 4, factuality: 4, completeness: 4 },
      },
      {
        candidateId: "candidate-b",
        architecture: "v2",
        writerModel: "qwen/qwen3.7-plus",
        scores: { usefulness: 4, voice: 4, factuality: 4, completeness: 4 },
      },
    ],
    preferredCandidateId: index % 2 ? "candidate-a" : "candidate-b",
    ...overrides,
  };
}

function writerComparison(
  writingClass: CoworkBlindComparison["writingClass"],
  index: number,
): CoworkBlindComparison {
  return {
    comparisonId: `writer-${writingClass}-${index}`,
    comparisonKind: "writer_model",
    writingClass,
    blind: true,
    candidates: [
      {
        candidateId: "writer-a",
        architecture: "v2",
        writerModel: "qwen/qwen3.7-plus",
        scores: { usefulness: 4, voice: 4, factuality: 4, completeness: 4 },
      },
      {
        candidateId: "writer-b",
        architecture: "v2",
        writerModel: "z-ai/glm-5.2",
        scores: { usefulness: 4, voice: 4, factuality: 4, completeness: 4 },
      },
    ],
    preferredCandidateId: index % 2 ? "writer-a" : "writer-b",
  };
}

describe("Cowork v2 rollout evidence", () => {
  test("reports contract, failure, fallback, latency, token, and charged-cost metrics", () => {
    const report = buildCoworkRolloutEvidence({
      runs: [
        run("v2", "original_post", 1),
        run("v2", "original_post", 2, {
          contractPassed: false,
          terminalOutcome: "hard_failure",
          fallbackUsed: true,
          latencyMs: 12_000,
          inputTokens: 2_000,
          outputTokens: 100,
          reasoningTokens: 25,
          cachedInputTokens: 500,
          chargedCostUsd: 0.03,
        }),
      ],
      blindComparisons: [],
    });

    expect(report.runs.overall).toMatchObject({
      runs: 2,
      productionShapedRuns: 2,
      completedProductionShapedRuns: 1,
      observedChargedCostRuns: 2,
      contractPassRate: 0.5,
      hardFailures: 1,
      hardFailureRate: 0.5,
      fallbacks: 1,
      fallbackRate: 0.5,
      latencyMs: { p50: 8_000, p95: 12_000, p99: 12_000 },
      tokens: {
        input: { total: 3_000, average: 1_500 },
        output: { total: 400, average: 200 },
        reasoning: { total: 25, average: 12.5 },
        cachedInput: { total: 700, average: 350 },
      },
      chargedCostUsd: { total: 0.04, average: 0.02 },
    });
    expect(report.runs.byJourney.original_post.runs).toBe(2);
    expect(report.runs.byVariant["v2-qwen"].runs).toBe(2);
  });

  test("fails closed when repeated runs, baselines, or blind scores are missing", () => {
    const report = buildCoworkRolloutEvidence({
      runs: [run("v2", "original_post", 1)],
      blindComparisons: [],
    });
    expect(report.promotion.status).toBe("blocked");
    expect(report.promotion.blockers).toEqual(
      expect.arrayContaining([
        "original_post:v2_runs_below_300",
        "original_post:baseline_runs_below_300",
        "original:blind_comparisons_below_20",
      ]),
    );
    expect(report.modelRecommendations.orchestrator.status).toBe(
      "insufficient_evidence",
    );
    expect(report.modelRecommendations.writer.status).toBe(
      "insufficient_evidence",
    );
  });

  test("passes only when every critical journey and writing class clears the strict gate", () => {
    const runs: CoworkEvidenceRun[] = [];
    for (const journey of COWORK_CRITICAL_JOURNEYS) {
      for (let index = 0; index < 300; index++) {
        runs.push(run("baseline", journey, index));
        runs.push(
          run("v2", journey, index, {
            ...(journey === "research_write"
              ? { modelComparisonGroup: "orchestrator-research-qwen" }
              : journey === "original_post"
                ? { modelComparisonGroup: "writer-original-direct" }
                : {}),
          }),
        );
        if (journey === "research_write") {
          runs.push(
            run("v2", journey, index + 300, {
              variantId: "v2-gemini-qwen",
              modelComparisonGroup: "orchestrator-research-qwen",
              orchestratorModel: "google/gemini-3.5-flash",
              writerModel: "qwen/qwen3.7-plus",
            }),
          );
        }
        if (journey === "original_post") {
          runs.push(
            run("v2", journey, index + 300, {
              variantId: "v2-glm",
              modelComparisonGroup: "writer-original-direct",
              writerModel: "z-ai/glm-5.2",
            }),
          );
        }
      }
    }
    const blindComparisons = COWORK_WRITING_CLASSES.flatMap((writingClass) => [
      ...Array.from({ length: 20 }, (_, index) =>
        comparison(writingClass, index),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        writerComparison(writingClass, index),
      ),
    ]);

    const report = buildCoworkRolloutEvidence({
      runs,
      blindComparisons,
      browserValidation: { desktop: "passed", mobile: "passed" },
    });

    expect(report.promotion).toEqual({ status: "passed", blockers: [] });
    expect(report.quality.byWritingClass.original).toMatchObject({
      comparisons: 20,
      baseline: {
        usefulness: 4,
        voice: 4,
        factuality: 4,
        completeness: 4,
        preferenceRate: 0.5,
      },
      v2: {
        usefulness: 4,
        voice: 4,
        factuality: 4,
        completeness: 4,
        preferenceRate: 0.5,
      },
    });
  });

  test("does not count incomplete or non-production attempts as 300 completed journeys", () => {
    const runs = Array.from({ length: 300 }, (_, index) =>
      run("v2", "original_post", index, {
        contractPassed: index !== 0,
        terminalOutcome: index === 0 ? "recoverable_error" : "delivered",
      }),
    );
    runs.push(
      run("v2", "original_post", 301, {
        productionShaped: false,
        contractPassed: false,
        terminalOutcome: "hard_failure",
        latencyMs: 500_000,
      }),
    );
    const report = buildCoworkRolloutEvidence({ runs, blindComparisons: [] });

    expect(report.runs.byArchitectureAndJourney.v2.original_post).toMatchObject({
      runs: 300,
      productionShapedRuns: 300,
      completedProductionShapedRuns: 299,
      hardFailures: 0,
      latencyMs: { p99: 8_000 },
    });
    expect(report.promotion.blockers).toContain(
      "original_post:v2_runs_below_300",
    );
  });

  test("blocks a contract, latency, fallback, cost, or blind-quality regression", () => {
    const runs: CoworkEvidenceRun[] = [];
    for (let index = 0; index < 301; index++) {
      runs.push(run("baseline", "original_post", index));
      runs.push(
        run("v2", "original_post", index, {
          contractPassed: index !== 0,
          terminalOutcome: index === 0 ? "hard_failure" : "delivered",
          fallbackUsed: index === 1,
          latencyMs: 31_000,
          chargedCostUsd: 0.03,
        }),
      );
    }
    const weak = Array.from({ length: 20 }, (_, index) =>
      comparison("original", index, {
        candidates: [
          comparison("original", index).candidates[0],
          {
            ...comparison("original", index).candidates[1],
            scores: {
              usefulness: 3,
              voice: 3,
              factuality: 3,
              completeness: 3,
            },
          },
        ],
        preferredCandidateId: "candidate-a",
      }),
    );
    const report = buildCoworkRolloutEvidence({ runs, blindComparisons: weak });

    expect(report.promotion.blockers).toEqual(
      expect.arrayContaining([
        "original_post:v2_hard_failures",
        "original_post:contract_regression",
        "original_post:fallback_regression",
        "original_post:p95_above_30000ms",
        "original_post:latency_regression",
        "original_post:cost_regression",
        "original:usefulness_regression",
        "original:preference_regression",
      ]),
    );
  });

  test("keeps scripted rows out of live reliability, latency, and cost comparisons", () => {
    const runs: CoworkEvidenceRun[] = [];
    for (let index = 0; index < 300; index++) {
      runs.push(run("baseline", "original_post", index));
      runs.push(
        run("v2", "original_post", index, {
          fallbackUsed: true,
          latencyMs: 31_000,
          chargedCostUsd: 0.03,
        }),
      );
    }
    for (let index = 0; index < 6_000; index++) {
      runs.push(
        run("v2", "original_post", index + 300, {
          variantId: "scripted-v2",
          evidenceSource: "scripted",
          costObserved: false,
          latencyMs: 1,
          chargedCostUsd: 0,
        }),
      );
    }

    const report = buildCoworkRolloutEvidence({ runs, blindComparisons: [] });

    expect(report.runs.byArchitectureAndJourney.v2.original_post).toMatchObject({
      runs: 6_300,
      latencyMs: { p95: 1 },
      chargedCostUsd: { total: 9, average: 0.03 },
    });
    expect(
      report.runs.byLiveArchitectureAndJourney.v2.original_post,
    ).toMatchObject({
      runs: 300,
      observedChargedCostRuns: 300,
      fallbackRate: 1,
      latencyMs: { p95: 31_000 },
      chargedCostUsd: { total: 9, average: 0.03 },
    });
    expect(report.promotion.blockers).toEqual(
      expect.arrayContaining([
        "original_post:fallback_regression",
        "original_post:p95_above_30000ms",
        "original_post:latency_regression",
        "original_post:cost_regression",
      ]),
    );
  });

  test("does not attribute a bundled Sonnet-Qwen versus Gemini-GLM comparison to either model", () => {
    const runs: CoworkEvidenceRun[] = [];
    for (let index = 0; index < 300; index++) {
      runs.push(
        run("v2", "research_write", index, {
          variantId: "sonnet-qwen",
          modelComparisonGroup: "confounded-bundle",
          orchestratorModel: "anthropic/claude-sonnet-5",
          writerModel: "qwen/qwen3.7-plus",
          latencyMs: 10_000,
          chargedCostUsd: 0.02,
        }),
        run("v2", "research_write", index + 300, {
          variantId: "gemini-glm",
          modelComparisonGroup: "confounded-bundle",
          orchestratorModel: "google/gemini-3.5-flash",
          writerModel: "z-ai/glm-5.2",
          latencyMs: 12_000,
          chargedCostUsd: 0.01,
        }),
      );
    }
    const report = buildCoworkRolloutEvidence({ runs, blindComparisons: [] });

    expect(report.modelRecommendations.orchestrator.status).toBe(
      "insufficient_evidence",
    );
    expect(report.modelRecommendations.writer.status).toBe(
      "insufficient_evidence",
    );
  });

  test("measures model ordering only from matched single-variable comparisons", () => {
    const runs: CoworkEvidenceRun[] = [];
    for (let index = 0; index < 300; index++) {
      runs.push(
        run("v2", "research_write", index, {
          variantId: "sonnet-qwen",
          modelComparisonGroup: "orchestrator-qwen",
          orchestratorModel: "anthropic/claude-sonnet-5",
          writerModel: "qwen/qwen3.7-plus",
          latencyMs: 10_000,
          chargedCostUsd: 0.02,
        }),
        run("v2", "research_write", index + 300, {
          variantId: "gemini-qwen",
          modelComparisonGroup: "orchestrator-qwen",
          orchestratorModel: "google/gemini-3.5-flash",
          writerModel: "qwen/qwen3.7-plus",
          latencyMs: 12_000,
          chargedCostUsd: 0.01,
        }),
        run("v2", "original_post", index + 600, {
          variantId: "direct-qwen",
          modelComparisonGroup: "writer-direct",
          orchestratorModel: undefined,
          writerModel: "qwen/qwen3.7-plus",
          latencyMs: 8_000,
          chargedCostUsd: 0.01,
        }),
        run("v2", "original_post", index + 900, {
          variantId: "direct-glm",
          modelComparisonGroup: "writer-direct",
          orchestratorModel: undefined,
          writerModel: "z-ai/glm-5.2",
          latencyMs: 9_000,
          chargedCostUsd: 0.015,
        }),
      );
    }
    const blindComparisons = COWORK_WRITING_CLASSES.flatMap((writingClass) =>
      Array.from({ length: 20 }, (_, index) =>
        writerComparison(writingClass, index),
      ),
    );
    const report = buildCoworkRolloutEvidence({ runs, blindComparisons });

    expect(report.modelRecommendations.orchestrator).toMatchObject({
      status: "measured",
      order: ["anthropic/claude-sonnet-5", "google/gemini-3.5-flash"],
    });
    expect(report.modelRecommendations.writer).toMatchObject({
      status: "measured",
      order: ["qwen/qwen3.7-plus", "z-ai/glm-5.2"],
    });
  });

  test("ranks matched models using failed attempts after each candidate qualifies", () => {
    const runs: CoworkEvidenceRun[] = [];
    for (let index = 0; index < 300; index++) {
      runs.push(
        run("v2", "research_write", index, {
          variantId: "sonnet-qwen",
          modelComparisonGroup: "orchestrator-reliability",
          orchestratorModel: "anthropic/claude-sonnet-5",
          writerModel: "qwen/qwen3.7-plus",
          latencyMs: 5_000,
          chargedCostUsd: 0.005,
        }),
        run("v2", "research_write", index + 300, {
          variantId: "gemini-qwen",
          modelComparisonGroup: "orchestrator-reliability",
          orchestratorModel: "google/gemini-3.5-flash",
          writerModel: "qwen/qwen3.7-plus",
          latencyMs: 12_000,
          chargedCostUsd: 0.01,
        }),
      );
    }
    for (let index = 0; index < 10; index++) {
      runs.push(
        run("v2", "research_write", index + 600, {
          variantId: "sonnet-qwen-failure",
          modelComparisonGroup: "orchestrator-reliability",
          orchestratorModel: "anthropic/claude-sonnet-5",
          writerModel: "qwen/qwen3.7-plus",
          costObserved: false,
          contractPassed: false,
          terminalOutcome: "hard_failure",
          latencyMs: 1_000,
          chargedCostUsd: 0,
        }),
      );
    }

    const report = buildCoworkRolloutEvidence({ runs, blindComparisons: [] });
    const sonnet = report.modelRecommendations.orchestrator.candidates.find(
      (candidate) => candidate.model === "anthropic/claude-sonnet-5",
    );

    expect(report.modelRecommendations.orchestrator).toMatchObject({
      status: "measured",
      order: ["google/gemini-3.5-flash", "anthropic/claude-sonnet-5"],
    });
    expect(sonnet?.runs).toMatchObject({
      runs: 310,
      completedProductionShapedRuns: 300,
      observedChargedCostRuns: 300,
      hardFailures: 10,
    });
    expect(sonnet?.runs.contractPassRate).toBeCloseTo(300 / 310);
  });
});
