import { describe, expect, test } from "vitest";
import type { DraftRecord } from "@/lib/draft-lifecycle";
import { existingQueueBooking } from "@/lib/posting-queue-idempotency";
import { readFileSync } from "node:fs";

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: "draft-1",
    title: "Queued draft",
    body: "Body",
    meta: null,
    kind: "post",
    status: "drafting",
    planToPostOn: "2026-07-27",
    chatId: null,
    createdAt: "2026-07-26T12:00:00.000Z",
    mediaAttachments: [],
    scheduledAt: "2026-07-27T08:00:00.000Z",
    scheduleStatus: "scheduled",
    firstComment: "Original comment",
    publishedAt: null,
    publishError: null,
    postingSlotId: "slot-1",
    postingSlotOccurrenceDate: "2026-07-27",
    lifecycleVersion: 2,
    ...overrides,
  };
}

describe("posting queue request idempotency", () => {
  test("returns an existing scheduled queue booking", () => {
    expect(existingQueueBooking(draft())).toEqual({
      scheduledAt: "2026-07-27T08:00:00.000Z",
      scheduleStatus: "scheduled",
      planToPostOn: "2026-07-27",
      firstComment: "Original comment",
      postingSlotId: "slot-1",
      postingSlotOccurrenceDate: "2026-07-27",
    });
  });

  test("treats an in-flight publish as the same queue booking", () => {
    expect(
      existingQueueBooking(draft({ scheduleStatus: "publishing" })),
    ).toMatchObject({ scheduleStatus: "publishing", postingSlotId: "slot-1" });
  });

  test("allows failed, one-off, and unscheduled drafts to be queued again", () => {
    expect(existingQueueBooking(draft({ scheduleStatus: "failed" }))).toBeNull();
    expect(existingQueueBooking(draft({ postingSlotId: null }))).toBeNull();
    expect(
      existingQueueBooking(
        draft({
          scheduleStatus: null,
          scheduledAt: null,
          postingSlotId: null,
          postingSlotOccurrenceDate: null,
        }),
      ),
    ).toBeNull();
  });

  test("the queue lifecycle write cannot replace an active recurring booking", () => {
    const route = readFileSync("app/api/drafts/[id]/queue/route.ts", "utf8");
    const repository = readFileSync(
      "lib/draft-lifecycle-supabase.ts",
      "utf8",
    );
    expect(route).toContain("preserveExistingQueue: true");
    expect(repository).toContain("requireNoActiveQueueBooking");
    expect(repository).toContain(
      "posting_slot_id.is.null,schedule_status.is.null,schedule_status.eq.failed",
    );
  });
});
