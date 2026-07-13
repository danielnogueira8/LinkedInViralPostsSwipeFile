import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { checkFocusedCoverage } from "@/scripts/check-focused-coverage.mjs";
import { flakyTests } from "@/scripts/assert-no-playwright-flakes.mjs";
import { buildLiveSummary, parseLiveContractReports } from "@/scripts/summarize-live-evals.mjs";

describe("layered quality CI", () => {
  test("focused coverage reports missing and below-threshold critical modules", () => {
    const policy = { modules: [{ path: "lib/x.ts", statements: 80, branches: 70, functions: 80, lines: 80 }] };
    const low = { statements: { pct: 79 }, branches: { pct: 80 }, functions: { pct: 80 }, lines: { pct: 80 } };
    expect(checkFocusedCoverage({ "/repo/lib/x.ts": low }, policy)).toEqual([
      "lib/x.ts statements: 79% < 80%",
    ]);
    expect(checkFocusedCoverage({}, policy)).toEqual(["lib/x.ts: missing from coverage output"]);
  });

  test("browser flake policy rejects failed-then-passed retries", () => {
    const report = {
      suites: [{ specs: [{ file: "e2e/a.spec.ts", title: "journey", tests: [{ results: [{ status: "failed" }, { status: "passed" }] }] }] }],
    };
    expect(flakyTests(report)).toEqual(["e2e/a.spec.ts: journey"]);
  });

  test("live trend parser consumes safe structured lines only", () => {
    const report = { id: "voice", completedRepetitions: 2, passes: 2, costUsd: 0.01, reservedCostUsd: 0.25 };
    expect(parseLiveContractReports(`noise\nLIVE_CONTRACT ${JSON.stringify(report)}\n`)).toEqual([report]);
    expect(buildLiveSummary([], "skipped", "fixed")).toMatchObject({
      status: "no_data",
      expectedContracts: 8,
      observedContracts: 0,
      commandOutcome: "skipped",
    });
    expect(buildLiveSummary([report], "failure", "fixed").status).toBe("failed");
  });

  test("workflows express blocking, artifact, schedule, and non-blocking policies", () => {
    const deterministic = readFileSync(".github/workflows/evals.yml", "utf8");
    const browser = readFileSync(".github/workflows/ui-e2e.yml", "utf8");
    const live = readFileSync(".github/workflows/live-contracts.yml", "utf8");
    expect(deterministic).toContain("npm run test:coverage");
    expect(browser).toContain("npm run e2e:critical:ci");
    expect(browser).toContain("critical-browser-evidence");
    expect(live).toContain("schedule:");
    expect(live).toContain("workflow_dispatch:");
    expect(live).toContain("continue-on-error: true");
    expect(live).toContain('LIVE_EVAL_SPEND_CEILING_USD: "2.00"');
  });
});
