import { describe, expect, test } from "vitest";
import {
  contractPassed,
  conservativeInputTokenBound,
  LiveSpendBudget,
  runLiveContract,
  safeReportLine,
  type LiveContract,
} from "@/evals/live/contract-runner";

const contract: LiveContract = {
  id: "exact-count-five",
  rule: "Return exactly five ideas",
  model: "test/model",
  parameters: { temperature: 0.2, maxTokens: 100 },
  repetitions: 3,
  minimumPassRate: 2 / 3,
  estimatedCostPerRunUsd: 0.04,
};

describe("budget-capped live contract runner", () => {
  test("stops before a repetition would cross the spend ceiling", async () => {
    const attempts: number[] = [];
    const report = await runLiveContract(contract, new LiveSpendBudget(0.09), async (attempt) => {
      attempts.push(attempt);
      return { pass: true, reason: "ok", actualCostUsd: 0.01 };
    });
    expect(attempts).toEqual([1, 2]);
    expect(report).toMatchObject({ completedRepetitions: 2, costUsd: 0.02, reservedCostUsd: 0.08 });
    expect(contractPassed(report)).toBe(false);
  });

  test("records repeatability metadata and threshold pass rate", async () => {
    const report = await runLiveContract(contract, new LiveSpendBudget(1), async (attempt) => ({
      pass: attempt !== 2,
      reason: attempt === 2 ? "variance" : "ok",
      actualCostUsd: 0.01,
    }));
    expect(report).toMatchObject({ repetitions: 3, passes: 2, passRate: 2 / 3 });
    expect(report.failures).toEqual([{ attempt: 2, reason: "variance" }]);
    expect(contractPassed(report)).toBe(true);
  });

  test("safe reports omit prompts, outputs, reasons, and redact secret diagnostics", async () => {
    const secret = "sk-or-v1-abcdefghijklmnopqrstuvwxyz123456";
    const report = await runLiveContract(contract, new LiveSpendBudget(1), async () => ({
      pass: false,
      reason: `model echoed ${secret}`,
      actualCostUsd: 0.01,
    }));
    expect(report.failures[0]?.reason).toContain("[REDACTED]");
    const line = safeReportLine(report);
    expect(line).not.toContain(secret);
    expect(line).not.toContain("model echoed");
    expect(line).not.toContain("Return exactly five ideas");
  });

  test("fails closed when authoritative provider cost exceeds the reserved bound", async () => {
    const report = await runLiveContract(contract, new LiveSpendBudget(1), async () => ({
      pass: true,
      reason: "ok",
      actualCostUsd: 0.05,
    }));
    expect(contractPassed(report)).toBe(false);
    expect(report.failures).toHaveLength(3);
  });

  test("byte-based input bound cannot undercount token-dense JSON or Unicode", () => {
    const dense = { punctuation: "{}[],:/".repeat(100), unicode: "🔥漢字".repeat(100) };
    const json = JSON.stringify(dense);
    expect(conservativeInputTokenBound(dense)).toBeGreaterThanOrEqual(json.length);
    expect(conservativeInputTokenBound(dense)).toBeGreaterThan(new TextEncoder().encode(json).length - 1);
  });
});
