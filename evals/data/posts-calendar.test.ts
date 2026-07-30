import { describe, test, expect } from "vitest";
import {
  dayKey,
  buildCalendarMonth,
  occurrencesForDate,
  bookableOccurrence,
  unscheduledDrafts,
  standaloneDraftsForDate,
} from "@/app/(app)/dashboard/posts/posts-calendar";
import type { Draft } from "@/lib/draft-view";
import type {
  PostingQueueDraft,
  PostingQueueSlot,
} from "@/lib/posting-queue";

// ---------------------------------------------------------------------------
// Calendar-view helpers for the Posts page: the month-grid math plus the
// queue-backed day bucketing behind the Board/Calendar toggle. Days are
// posting-queue slot occurrences (the current scheduling model), not the
// retired planning dates.
// ---------------------------------------------------------------------------

function draft(p: Partial<Draft> & { id: string }): Draft {
  return {
    title: null,
    body: "body",
    kind: "post",
    status: "drafting",
    planToPostOn: null,
    chatId: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...p,
  } as Draft;
}

const mondaySlot: PostingQueueSlot = {
  id: "slot-mon",
  dayOfWeek: 1,
  localTime: "09:00",
  timezone: "UTC",
};
const mondayEveningSlot: PostingQueueSlot = {
  id: "slot-mon-pm",
  dayOfWeek: 1,
  localTime: "17:30",
  timezone: "UTC",
};

describe("dayKey — local YYYY-MM-DD", () => {
  test("formats with zero padding", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("buildCalendarMonth — Monday-first 42-cell grid", () => {
  test("always returns 42 cells", () => {
    expect(buildCalendarMonth(2026, 5)).toHaveLength(42);
  });

  test("the displayed month's days are flagged inMonth; padding days are not", () => {
    const cells = buildCalendarMonth(2026, 5); // June 2026
    const june = cells.filter((c) => c.inMonth);
    expect(june).toHaveLength(30);
    expect(june[0]!.date.getDate()).toBe(1);
    expect(june[june.length - 1]!.date.getDate()).toBe(30);
    for (const c of june) {
      expect(c.date.getMonth()).toBe(5);
      expect(c.date.getFullYear()).toBe(2026);
    }
  });

  test("a month NOT starting on Monday has leading padding days", () => {
    // August 2026 starts on a Saturday → leading Mon-Fri are July padding.
    const cells = buildCalendarMonth(2026, 7);
    expect(cells[0]!.inMonth).toBe(false);
    expect(cells[0]!.date.getMonth()).toBe(6);
    expect(cells.find((c) => c.inMonth)!.date.getDate()).toBe(1);
  });

  test("the grid starts on a Monday", () => {
    for (const month of [0, 3, 7, 11]) {
      expect(buildCalendarMonth(2026, month)[0]!.date.getDay()).toBe(1);
    }
  });
});

describe("occurrencesForDate — queue slots on a day", () => {
  // 2026-08-03 is a Monday.
  const monday = "2026-08-03";
  const tuesday = "2026-08-04";

  test("only slots whose weekday matches the date occur", () => {
    const occurrences = occurrencesForDate([mondaySlot], [], monday);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.slot.id).toBe("slot-mon");
    expect(occurrences[0]!.draft).toBeNull();
    expect(occurrencesForDate([mondaySlot], [], tuesday)).toHaveLength(0);
  });

  test("occurrences sort by their slot instant", () => {
    const occurrences = occurrencesForDate(
      [mondayEveningSlot, mondaySlot],
      [],
      monday,
    );
    expect(occurrences.map((o) => o.slot.id)).toEqual(["slot-mon", "slot-mon-pm"]);
  });

  test("a queue draft occupies its slot+date occurrence", () => {
    const booking: PostingQueueDraft = {
      id: "draft-1",
      title: "Booked",
      scheduledAt: "2026-08-03T09:00:00.000Z",
      scheduleStatus: "scheduled",
      postingSlotId: "slot-mon",
      postingSlotOccurrenceDate: monday,
    };
    const occurrences = occurrencesForDate([mondaySlot], [booking], monday);
    expect(occurrences[0]!.draft?.id).toBe("draft-1");
  });
});

describe("bookableOccurrence — where a drop lands", () => {
  const monday = "2026-08-03";
  const now = new Date("2026-08-01T12:00:00.000Z");

  test("the earliest open slot wins", () => {
    const occurrence = bookableOccurrence(
      [mondayEveningSlot, mondaySlot],
      [],
      monday,
      now,
    );
    expect(occurrence?.slot.id).toBe("slot-mon");
  });

  test("an actively-held slot is skipped for the next open one", () => {
    const holding: PostingQueueDraft = {
      id: "draft-1",
      title: "Held",
      scheduledAt: "2026-08-03T09:00:00.000Z",
      scheduleStatus: "scheduled",
      postingSlotId: "slot-mon",
      postingSlotOccurrenceDate: monday,
    };
    const occurrence = bookableOccurrence(
      [mondaySlot, mondayEveningSlot],
      [holding],
      monday,
      now,
    );
    expect(occurrence?.slot.id).toBe("slot-mon-pm");
  });

  test("a fully-booked or fully-past day has no bookable occurrence", () => {
    const holding: PostingQueueDraft = {
      id: "draft-1",
      title: "Held",
      scheduledAt: "2026-08-03T09:00:00.000Z",
      scheduleStatus: "publishing",
      postingSlotId: "slot-mon",
      postingSlotOccurrenceDate: monday,
    };
    expect(bookableOccurrence([mondaySlot], [holding], monday, now)).toBeNull();
    expect(
      bookableOccurrence([mondaySlot], [], monday, new Date("2026-08-04T00:00:00.000Z")),
    ).toBeNull();
    expect(bookableOccurrence([], [], monday, now)).toBeNull();
  });
});

describe("draft bucketing — tray vs standalone chips", () => {
  test("the tray holds unscheduled, unposted drafts", () => {
    const tray = unscheduledDrafts([
      draft({ id: "a" }),
      draft({ id: "b", scheduledAt: "2026-08-03T09:00:00.000Z", scheduleStatus: "scheduled" }),
      draft({ id: "c", status: "posted" }),
    ]);
    expect(tray.map((d) => d.id)).toEqual(["a"]);
  });

  test("queue-booked drafts never duplicate as standalone chips", () => {
    const booked = draft({
      id: "a",
      scheduledAt: "2026-08-03T09:00:00.000Z",
      scheduleStatus: "scheduled",
      postingSlotId: "slot-mon",
      postingSlotOccurrenceDate: "2026-08-03",
    });
    expect(standaloneDraftsForDate([booked], "2026-08-03")).toHaveLength(0);
  });

  test("a directly-scheduled draft chips on its local schedule date", () => {
    const direct = draft({
      id: "a",
      scheduledAt: "2026-08-03T09:00:00.000Z",
      scheduleStatus: "scheduled",
    });
    expect(standaloneDraftsForDate([direct], "2026-08-03").map((d) => d.id)).toEqual(["a"]);
    expect(standaloneDraftsForDate([direct], "2026-08-04")).toHaveLength(0);
  });

  test("a posted draft chips on its publish date", () => {
    const posted = draft({
      id: "a",
      status: "posted",
      publishedAt: "2026-07-28T15:00:00.000Z",
    });
    expect(standaloneDraftsForDate([posted], "2026-07-28").map((d) => d.id)).toEqual(["a"]);
    expect(standaloneDraftsForDate([posted], "2026-07-29")).toHaveLength(0);
  });
});
