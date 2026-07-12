import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { formatCoverageSummary } from "@/scripts/coverage-summary.mjs";

type Journey = {
  id: string;
  capability: string;
  invariant: string;
  preferred_seam: "unit" | "api-contract" | "agent-loop" | "browser" | "live-model";
  existing_coverage: string[];
  status: "protected" | "partial" | "gap";
  follow_up_issue: number;
};

const requiredCapabilities = [
  "Cowork",
  "Swipe File",
  "Bookmarks",
  "Accounts and sources",
  "Drafts",
  "Templates, styles, and skills",
  "Lead magnets",
  "Media",
  "Scheduling and publishing",
  "Batches and jobs",
  "Quotas and cost controls",
  "Authentication",
  "Workspace isolation",
];

describe("critical journey inventory", () => {
  const matrix = JSON.parse(
    readFileSync(resolve("docs/testing/critical-journeys.json"), "utf8"),
  ) as { version: number; journeys: Journey[] };

  test("covers every required product capability", () => {
    expect(matrix.version).toBe(1);
    expect(new Set(matrix.journeys.map((row) => row.capability))).toEqual(
      new Set(requiredCapabilities),
    );
  });

  test("every row names its invariant, seam, evidence, status, and follow-up", () => {
    expect(matrix.journeys.length).toBeGreaterThanOrEqual(requiredCapabilities.length);
    for (const row of matrix.journeys) {
      expect(row.id).toMatch(/^[a-z0-9-]+$/);
      expect(row.invariant.trim().length).toBeGreaterThan(20);
      expect(["unit", "api-contract", "agent-loop", "browser", "live-model"]).toContain(
        row.preferred_seam,
      );
      expect(row.existing_coverage.length).toBeGreaterThan(0);
      for (const path of row.existing_coverage) {
        expect(() => readFileSync(resolve(path), "utf8"), path).not.toThrow();
      }
      expect(["protected", "partial", "gap"]).toContain(row.status);
      expect(row.follow_up_issue).toBeGreaterThanOrEqual(998);
      expect(row.follow_up_issue).toBeLessThanOrEqual(1005);
    }
  });
});

describe("coverage summary formatter", () => {
  test("prints the four coverage dimensions without enforcing a threshold", () => {
    const output = formatCoverageSummary({
      total: {
        statements: { pct: 32.25 },
        branches: { pct: 77.47 },
        functions: { pct: 59.22 },
        lines: { pct: 32.25 },
      },
    });

    expect(output).toContain("Statements: 32.25%");
    expect(output).toContain("Branches: 77.47%");
    expect(output).toContain("Functions: 59.22%");
    expect(output).toContain("Lines: 32.25%");
    expect(output).not.toMatch(/pass|fail|threshold/i);
  });
});
