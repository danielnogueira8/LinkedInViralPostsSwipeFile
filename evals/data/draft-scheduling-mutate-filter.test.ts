import { describe, expect, test } from "vitest";
import {
  SCHEDULABLE_SCHEDULE_STATUS_FILTER,
  MUTATABLE_SCHEDULE_STATUS_FILTER,
} from "@/lib/draft-scheduling";

// Bug-hunt fix (task #189) — the SQL-level backstop half of the fix. The app
// layer (DraftLifecycle.mutate, tested in draft-lifecycle.test.ts) already
// rejects a mutation on a 'scheduled' draft before ever reaching the
// repository. This pins the repository's OWN filter as the independent
// guarantee: MUTATABLE_SCHEDULE_STATUS_FILTER (used by mutate()'s CAS write)
// must be strictly narrower than SCHEDULABLE_SCHEDULE_STATUS_FILTER (used by
// schedule()/remove(), which legitimately touch a 'scheduled' row) — it must
// NOT include 'scheduled', so a future caller that bypasses the app-layer
// check still can't silently mutate a queued draft's fields at the DB level.
describe("draft-scheduling — mutate() vs schedule()/remove() filter scope", () => {
  test("MUTATABLE_SCHEDULE_STATUS_FILTER excludes 'scheduled'", () => {
    expect(MUTATABLE_SCHEDULE_STATUS_FILTER).not.toContain("scheduled");
    expect(MUTATABLE_SCHEDULE_STATUS_FILTER).toBe(
      "schedule_status.is.null,schedule_status.eq.failed",
    );
  });

  test("SCHEDULABLE_SCHEDULE_STATUS_FILTER (schedule()/remove()) still legitimately includes 'scheduled'", () => {
    // Re-scheduling an already-scheduled draft, and deleting one outright,
    // are both intentional exceptions — unaffected by this fix.
    expect(SCHEDULABLE_SCHEDULE_STATUS_FILTER).toContain("scheduled");
  });

  test("both filters agree on the null and 'failed' cases (no drift between them)", () => {
    expect(SCHEDULABLE_SCHEDULE_STATUS_FILTER).toContain("schedule_status.is.null");
    expect(MUTATABLE_SCHEDULE_STATUS_FILTER).toContain("schedule_status.is.null");
    expect(SCHEDULABLE_SCHEDULE_STATUS_FILTER).toContain("failed");
    expect(MUTATABLE_SCHEDULE_STATUS_FILTER).toContain("failed");
  });
});
