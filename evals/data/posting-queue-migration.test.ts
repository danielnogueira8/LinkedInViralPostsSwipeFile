import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync("db/migration-138-posting-queue.sql", "utf8");

describe("posting queue migration", () => {
  test("enforces slot limits, unique local times, and concurrent occurrence claims", () => {
    expect(sql).toContain("posting_slots_max_three_per_day");
    expect(sql).toContain("posting_slots_workspace_day_time_idx");
    expect(sql).toContain("posting_slot_occurrence_date");
    expect(sql).toContain("chat_artifacts_posting_slot_occurrence_idx");
    expect(sql).toContain("next_posting_queue_occurrence");
    expect(sql).toContain("The unique occurrence index is the final concurrent");
  });

  test("preserves scheduled instants when a slot is removed", () => {
    expect(sql).toContain("remove_posting_slot");
    expect(sql).toMatch(
      /set[\s\S]*posting_slot_id\s*=\s*null,\s*posting_slot_occurrence_date\s*=\s*null/i,
    );
  });

  test("normalizes DST gaps and records a server log", () => {
    expect(sql).toContain("posting_slot_utc_instant");
    expect(sql).toContain("raise log");
  });
});
