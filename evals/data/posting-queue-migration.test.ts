import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync("db/migration-138-posting-queue.sql", "utf8");
const allocatorFix = readFileSync(
  "db/migration-140-posting-queue-allocator.sql",
  "utf8",
);
const atomicSlotCreation = readFileSync(
  "db/migration-141-atomic-posting-slot-creation.sql",
  "utf8",
);
const postingSlotsRoute = readFileSync("app/api/posting-slots/route.ts", "utf8");
const publishingSlotRemoval = readFileSync(
  "db/migration-142-publishing-slot-removal.sql",
  "utf8",
);
const queueSlotIntegrity = readFileSync(
  "db/migration-143-posting-queue-slot-integrity.sql",
  "utf8",
);

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
    expect(publishingSlotRemoval).toContain(
      "schedule_status in ('scheduled', 'publishing', 'failed')",
    );
    expect(publishingSlotRemoval).not.toMatch(/scheduled_at\s*=/i);
  });

  test("normalizes DST gaps and records a server log", () => {
    expect(sql).toContain("posting_slot_utc_instant");
    expect(sql).toContain("raise log");
  });

  test("walks weekly occurrences only until each slot has an opening", () => {
    expect(sql).toContain("generated_day.day_number");
    expect(sql).not.toMatch(/\+\s+offset\b/i);
    expect(allocatorFix).toContain("with recursive candidates");
    expect(allocatorFix).toContain("occurrence_date + 7");
    expect(allocatorFix).not.toContain("generate_series(0, 730)");
    expect(allocatorFix).not.toMatch(/\+\s+offset\b/i);
  });

  test("locks before checking the daily slot cap", () => {
    expect(atomicSlotCreation).toContain("create_posting_slot");
    expect(atomicSlotCreation).toMatch(
      /pg_advisory_xact_lock[\s\S]*select count\(\*\)[\s\S]*insert into posting_slots/i,
    );
    expect(atomicSlotCreation).toContain(
      "revoke all on function create_posting_slot",
    );
    expect(atomicSlotCreation).toContain(
      "grant execute on function create_posting_slot",
    );
    expect(postingSlotsRoute).toContain('.rpc("create_posting_slot"');
    expect(postingSlotsRoute).not.toMatch(
      /\.from\("posting_slots"\)\s*\.insert\(/,
    );
  });

  test("serializes queue claims with recurring slot removal", () => {
    expect(queueSlotIntegrity).toContain("posting_queue_active_slot_guard");
    expect(queueSlotIntegrity).toMatch(
      /from public\.posting_slots[\s\S]*deleted_at is null[\s\S]*for update/i,
    );
    expect(queueSlotIntegrity).toContain("using errcode = '40001'");
    expect(queueSlotIntegrity).toContain(
      "before insert or update of posting_slot_id",
    );
  });
});
