import { describe, expect, test } from "vitest";
import {
  assertSafeEvidenceKeys,
  parseEvidenceInput,
} from "@/scripts/cowork-v2-rollout-report.mjs";

const run = {
  runId: "run-1",
  architecture: "v2",
  journey: "original_post",
  variantId: "qwen",
  evidenceSource: "live",
  productionShaped: true,
  costObserved: true,
  contractPassed: true,
  terminalOutcome: "delivered",
  fallbackUsed: false,
  latencyMs: 100,
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: 0,
  cachedInputTokens: 2,
  chargedCostUsd: 0.001,
  writerModel: "qwen/qwen3.7-plus",
};

const writerComparison = {
  comparisonId: "writer-1",
  comparisonKind: "writer_model",
  writingClass: "original",
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
  preferredCandidateId: "tie",
};

describe("Cowork v2 rollout report input", () => {
  test("accepts safe JSONL evidence envelopes", () => {
    const parsed = parseEvidenceInput(
      [
        JSON.stringify({ type: "run", data: run }),
        JSON.stringify({
          type: "browser_validation",
          data: { desktop: "passed", mobile: "pending" },
        }),
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      runs: [run],
      blindComparisons: [],
      browserValidation: { desktop: "passed", mobile: "pending" },
    });
  });

  test("rejects prompt, body, credentials, and reasoning text before report generation", () => {
    for (const unsafe of [
      { prompt: "private prompt" },
      { draftBody: "private draft" },
      { credential: "secret" },
      { reasoning_content: "hidden reasoning" },
    ]) {
      expect(() => assertSafeEvidenceKeys(unsafe)).toThrow(/Unsafe evidence field/);
    }
    expect(() => assertSafeEvidenceKeys({ reasoningTokens: 42 })).not.toThrow();
  });

  test("rejects malformed or extra fields instead of guessing", () => {
    expect(() =>
      parseEvidenceInput(
        JSON.stringify({
          runs: [{ ...run, latencyMs: -1, extra: "not allowed" }],
          blindComparisons: [],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEvidenceInput(
        JSON.stringify({
          type: "run",
          data: { ...run, evidenceSource: "scripted", costObserved: true },
        }),
      ),
    ).toThrow(/Only live provider evidence/);
    expect(() =>
      parseEvidenceInput(
        [
          JSON.stringify({ type: "run", data: run }),
          JSON.stringify({ type: "unknown", data: {} }),
        ].join("\n"),
      ),
    ).toThrow();
    expect(() =>
      parseEvidenceInput(
        JSON.stringify({
          runs: [],
          blindComparisons: [
            {
              ...writerComparison,
              candidates: [
                writerComparison.candidates[0],
                {
                  ...writerComparison.candidates[1],
                  writerModel: "meta-llama/llama-4",
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/distinct writer models/);
    expect(() =>
      parseEvidenceInput(
        JSON.stringify({
          runs: [],
          blindComparisons: [
            {
              ...writerComparison,
              candidates: [
                {
                  ...writerComparison.candidates[0],
                  orchestratorModel: "anthropic/claude-sonnet-5",
                },
                {
                  ...writerComparison.candidates[1],
                  orchestratorModel: "google/gemini-3.5-flash",
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/hold the orchestrator model constant/);
  });
});
