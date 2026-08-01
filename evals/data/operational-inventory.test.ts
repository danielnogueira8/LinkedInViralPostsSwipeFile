import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

type OperationalInvariant = {
  id: string;
  boundary: string;
  invariant: string;
  evidence: Array<{ path: string; test: string }>;
};

const required = [
  "manual-source-cap",
  "chat-count-cost-claim",
  "lead-magnet-count-cost-claim",
  "media-byte-claim",
  "scrape-singleton-recovery",
  "background-job-lease",
  "provider-capacity-lock",
  "analytics-refresh-lease",
  "modeled-source-rotation-claim",
  "posting-queue-slot-claim",
  "cron-partial-failure-alert",
  "cowork-action-checkpoint",
  "agent-opportunity-draft-claim",
  "agent-opportunity-action-transition",
  "agent-loop-workspace-fairness",
];

describe("operational invariant inventory", () => {
  const matrix = JSON.parse(
    readFileSync(resolve("docs/testing/operational-invariants.json"), "utf8"),
  ) as { version: number; invariants: OperationalInvariant[] };

  test("names every concurrency, quota, lease, and recovery boundary", () => {
    expect(matrix.version).toBe(1);
    expect(matrix.invariants.map((row) => row.id).sort()).toEqual([...required].sort());
  });

  test("each invariant links to deterministic evidence that exists", () => {
    for (const row of matrix.invariants) {
      expect(row.id).toMatch(/^[a-z0-9-]+$/);
      expect(row.boundary.trim().length).toBeGreaterThan(5);
      expect(row.invariant.trim().length).toBeGreaterThan(30);
      expect(row.evidence.length).toBeGreaterThan(0);
      for (const evidence of row.evidence) {
        const source = readFileSync(resolve(evidence.path), "utf8");
        expect(source, `${evidence.path} must contain ${evidence.test}`).toContain(
          evidence.test,
        );
      }
    }
  });
});
