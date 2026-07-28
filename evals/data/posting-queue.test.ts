import { describe, expect, test } from "vitest";
import {
  buildPostingQueueDays,
  canDragDraftToPostingQueue,
  formatScheduleToast,
  postingSlotHasActiveDraft,
  type PostingQueueSlot,
} from "@/lib/posting-queue";

describe("posting queue drag eligibility", () => {
  test.each(["idea", "drafting", "ready"] as const)(
    "allows %s posts",
    (status) => {
      expect(
        canDragDraftToPostingQueue({
          status,
          scheduleStatus: null,
        }),
      ).toBe(true);
    },
  );

  test("allows a scheduled post to be moved to another occurrence", () => {
    expect(
      canDragDraftToPostingQueue({
        status: "ready",
        scheduleStatus: "scheduled",
      }),
    ).toBe(true);
  });

  test.each([
    { status: "ready", scheduleStatus: "publishing" },
    { status: "posted", scheduleStatus: "published" },
    { status: "posted", scheduleStatus: null },
  ] as const)("rejects locked or posted drafts", (draft) => {
    expect(canDragDraftToPostingQueue(draft)).toBe(false);
  });
});

const slots: PostingQueueSlot[] = [
  {
    id: "monday-9",
    dayOfWeek: 1,
    localTime: "09:00:00",
    timezone: "Europe/Lisbon",
  },
  {
    id: "monday-14",
    dayOfWeek: 1,
    localTime: "14:00:00",
    timezone: "Europe/Lisbon",
  },
];

describe("buildPostingQueueDays", () => {
  test("always returns today plus the next six calendar days", () => {
    const days = buildPostingQueueDays(
      slots,
      [],
      new Date("2026-07-27T08:00:00.000Z"),
      "Europe/Lisbon",
    );
    expect(days).toHaveLength(7);
    expect(days.map((day) => day.date)).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(days[0].isToday).toBe(true);
    expect(days[0].occurrences.map((item) => item.slot.id)).toEqual([
      "monday-9",
      "monday-14",
    ]);
  });

  test("hides passed occurrences today without removing future recurring slots", () => {
    const days = buildPostingQueueDays(
      slots,
      [],
      new Date("2026-07-27T12:00:00.000Z"),
      "Europe/Lisbon",
    );
    expect(days[0].occurrences.map((item) => item.slot.id)).toEqual(["monday-14"]);
    expect(days[0].noSlotsLeftToday).toBe(false);

    const late = buildPostingQueueDays(
      slots,
      [],
      new Date("2026-07-27T18:00:00.000Z"),
      "Europe/Lisbon",
    );
    expect(late[0].occurrences).toEqual([]);
    expect(late[0].noSlotsLeftToday).toBe(true);
    expect(late[6].occurrences).toEqual([]);
  });

  test("marks a scheduled occurrence filled and excludes published posts", () => {
    const days = buildPostingQueueDays(
      slots,
      [
        {
          id: "draft-1",
          title: "A deliberately long draft title",
          scheduledAt: "2026-07-27T08:00:00.000Z",
          scheduleStatus: "scheduled",
          postingSlotId: "monday-9",
          postingSlotOccurrenceDate: "2026-07-27",
        },
        {
          id: "published",
          title: "Already sent",
          scheduledAt: "2026-07-27T13:00:00.000Z",
          scheduleStatus: "published",
          postingSlotId: "monday-14",
          postingSlotOccurrenceDate: "2026-07-27",
        },
      ],
      new Date("2026-07-27T07:00:00.000Z"),
      "Europe/Lisbon",
    );
    expect(days[0].occurrences[0].draft?.id).toBe("draft-1");
    expect(days[0].occurrences[1].draft).toBeNull();
  });

  test("filters and orders an edited occurrence by its effective publishing time", () => {
    const days = buildPostingQueueDays(
      slots,
      [
        {
          id: "edited",
          title: "Edited to later",
          scheduledAt: "2026-07-27T12:00:00.000Z",
          scheduleStatus: "scheduled",
          postingSlotId: "monday-9",
          postingSlotOccurrenceDate: "2026-07-27",
        },
      ],
      new Date("2026-07-27T10:00:00.000Z"),
      "Europe/Lisbon",
    );

    expect(days[0].occurrences.map((item) => item.slot.id)).toEqual([
      "monday-9",
      "monday-14",
    ]);
    expect(days[0].occurrences[0].scheduledAt).toBe(
      "2026-07-27T12:00:00.000Z",
    );
  });
});

describe("formatScheduleToast", () => {
  test("uses Tomorrow and always includes date and time", () => {
    expect(
      formatScheduleToast({
        scheduledAt: "2026-07-27T08:00:00.000Z",
        now: new Date("2026-07-26T10:00:00.000Z"),
        accountTimezone: "Europe/Lisbon",
        browserTimezone: "Europe/Lisbon",
      }),
    ).toBe("Post scheduled for Tomorrow, Jul 27 at 9:00 AM");
  });

  test("adds the account timezone when it differs from the browser", () => {
    expect(
      formatScheduleToast({
        scheduledAt: "2026-07-27T08:00:00.000Z",
        now: new Date("2026-07-26T10:00:00.000Z"),
        accountTimezone: "Europe/Lisbon",
        browserTimezone: "America/New_York",
        action: "rescheduled",
      }),
    ).toMatch(/^Post rescheduled for Tomorrow, Jul 27 at 9:00 AM (GMT\+1|WEST)$/);
  });
});

describe("postingSlotHasActiveDraft", () => {
  const queuedDraft = {
    id: "draft-1",
    title: "Draft",
    scheduledAt: "2026-07-27T08:00:00.000Z",
    scheduleStatus: "publishing",
    postingSlotId: "monday-9",
    postingSlotOccurrenceDate: "2026-07-27",
  };

  test("warns while a slot occurrence is actively publishing", () => {
    expect(postingSlotHasActiveDraft([queuedDraft], "monday-9")).toBe(true);
  });

  test("does not warn for another slot or a published post", () => {
    expect(postingSlotHasActiveDraft([queuedDraft], "monday-14")).toBe(false);
    expect(
      postingSlotHasActiveDraft(
        [{ ...queuedDraft, scheduleStatus: "published" }],
        "monday-9",
      ),
    ).toBe(false);
  });
});
