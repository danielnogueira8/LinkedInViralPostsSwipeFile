import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const requiredInvariants = [
  "source-ownership",
  "unsent-draft-persistence",
  "attachment-ownership",
  "transcript-hydration",
  "running-stream-isolation",
  "stop-retry-recovery",
  "artifact-handoff-deduplication",
  "navigation-and-background-reconciliation",
  "checkpointed-action-idempotency",
];

describe("Cowork state invariant inventory", () => {
  const inventory = JSON.parse(
    readFileSync(resolve("docs/testing/cowork-state-invariants.json"), "utf8"),
  ) as { version: number; invariants: Array<{ id: string; evidence: string[] }> };

  test("covers every required chat state transition family", () => {
    expect(inventory.version).toBe(1);
    expect(new Set(inventory.invariants.map((row) => row.id))).toEqual(
      new Set(requiredInvariants),
    );
  });

  test("every invariant links executable regression evidence", () => {
    for (const invariant of inventory.invariants) {
      expect(invariant.evidence.length).toBeGreaterThan(0);
      for (const evidence of invariant.evidence) {
        const source = readFileSync(resolve(evidence), "utf8");
        expect(source).toMatch(/\b(?:test|describe)\s*\(/);
      }
    }
  });
});
