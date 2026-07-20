import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../db/migration-108-modeled-draft-count-six.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 108 modeled draft count of six", () => {
  test("widens the batch expected_count check from 2-5 to 2-6", () => {
    expect(migration).toContain(
      "drop constraint if exists modeled_draft_batches_expected_count_check",
    );
    expect(migration).toContain("check (expected_count between 2 and 6)");
    expect(migration).not.toContain("expected_count between 2 and 5");
  });

  test("widens the slot index check so six drafts occupy slots 0-5", () => {
    expect(migration).toContain(
      "drop constraint if exists modeled_draft_slots_slot_index_check",
    );
    expect(migration).toContain("check (slot_index between 0 and 5)");
    expect(migration).not.toContain("slot_index between 0 and 4");
  });

  test("re-creates the claim and checkpoint guards with the 2-6 bounds", () => {
    expect(migration).toContain("or p_expected_count not between 2 and 6");
    expect(migration).not.toContain("p_expected_count not between 2 and 5");
    expect(migration).toContain("or p_slot_index not between 0 and 5");
    expect(migration).not.toContain("p_slot_index not between 0 and 4");
  });

  test("advances deployment readiness to schema version 108", () => {
    expect(migration).toContain("values (true, 108, now())");
  });
});
