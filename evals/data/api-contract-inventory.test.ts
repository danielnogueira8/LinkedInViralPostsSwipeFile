import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

type ContractFamily = {
  id: string;
  success_evidence: string[];
  failure_evidence: string[];
  isolation_evidence: string[];
  mutation_evidence: string[];
};

const requiredFamilies = [
  "accounts-sources",
  "bookmarks-sharing",
  "cowork-chats",
  "drafts-artifacts",
  "templates-styles-skills",
  "lead-magnets",
  "media",
  "scheduling-publishing",
  "batches-jobs-cron",
  "quotas-cost-controls",
  "authentication-workspaces",
  "settings-preferences-feedback",
  "integrations-account-lifecycle",
];

describe("critical API contract inventory", () => {
  const inventory = JSON.parse(
    readFileSync(resolve("docs/testing/api-contracts.json"), "utf8"),
  ) as { version: number; families: ContractFamily[] };

  test("covers every critical API route family", () => {
    expect(inventory.version).toBe(1);
    expect(new Set(inventory.families.map((family) => family.id))).toEqual(
      new Set(requiredFamilies),
    );
  });

  test("every family links success, failure, isolation, and mutation evidence", () => {
    for (const family of inventory.families) {
      for (const evidence of [
        ...family.success_evidence,
        ...family.failure_evidence,
        ...family.isolation_evidence,
        ...family.mutation_evidence,
      ]) {
        const source = readFileSync(resolve(evidence), "utf8");
        expect(source, `${evidence} must drive a real app/api route`).toContain(
          "@/app/api/",
        );
      }
      expect(family.success_evidence.length).toBeGreaterThan(0);
      expect(family.failure_evidence.length).toBeGreaterThan(0);
      expect(family.isolation_evidence.length).toBeGreaterThan(0);
      expect(family.mutation_evidence.length).toBeGreaterThan(0);
    }
  });
});
