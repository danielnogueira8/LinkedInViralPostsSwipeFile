import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("live product contract inventory", () => {
  const source = readFileSync("evals/live/product-contracts.live.test.ts", "utf8");
  const required = [
    "tool-selection-top-posts",
    "prompt-adherence-no-clarification",
    "source-fidelity-fixed-claim",
    "voice-short-direct-no-emoji",
    "post-type-lead-magnet",
    "exact-count-five-hooks",
    "lead-magnet-comment-keyword",
    "anti-slop-banned-language",
  ];

  test("defines one named rule for every nondeterministic product boundary", () => {
    for (const id of required) expect(source).toContain(`id: "${id}"`);
    expect(source.match(/rule: "[^"]+"/g)).toHaveLength(required.length);
  });

  test("uses fixed fixtures, repeated thresholds, and the shared spend ceiling", () => {
    expect(source).toContain("fixtureVersion: 1");
    expect(source).toContain("minimumPassRate: 0.8");
    expect(source).toContain("liveSpendCeiling()");
    expect(source).toContain("safeReportLine(report)");
    expect(source).toContain("estimatedCostPerRunUsd: 0.125");
    const agent = readFileSync("lib/agent/run.ts", "utf8");
    expect(agent).toContain('process.env.RUN_LIVE_EVALS === "1" ? 2 : 14');
    expect(agent).toContain('process.env.RUN_LIVE_EVALS === "1" ? 1024 : 8192');
  });

  test("live test logs do not print raw model bodies or lists", () => {
    for (const path of [
      "evals/live/output-quality.live.test.ts",
      "evals/live/prompt-quality-audit.live.test.ts",
    ]) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toMatch(/console\.log\([^)]*(?:BODY|FULL TEXT|LIST1|deliverable)/);
    }
  });
});
