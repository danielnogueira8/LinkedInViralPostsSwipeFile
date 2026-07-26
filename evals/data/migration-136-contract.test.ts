import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  "db/migration-136-complete-workspace-learning-outcomes.sql",
  "utf8",
);

describe("migration 136 contract", () => {
  test("returns every active outcome with the fields used for weighting", () => {
    expect(sql).toContain("outcome_kind text");
    expect(sql).toContain("outcome_source text");
    expect(sql).toContain("outcome_confidence double precision");
    expect(sql).toContain("outcome_amount_minor bigint");
    expect(sql).not.toMatch(/from public\.content_outcomes result[\s\S]*?limit 1/);
  });

  test("bounds requested artifacts and remains service-only", () => {
    expect(sql).toContain("limit 50");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
