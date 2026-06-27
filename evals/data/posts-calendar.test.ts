import { describe, test, expect } from "vitest";
import {
  dayKey,
  groupPostsByDay,
  buildCalendarMonth,
  type Draft,
} from "@/app/(app)/dashboard/posts/drafts-list";

// ---------------------------------------------------------------------------
// Calendar-view helpers for the Posts page: the month-grid math + the
// by-day/unscheduled bucketing behind the calendar/kanban toggle.
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
  };
}

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
    expect(june).toHaveLength(30); // June has 30 days
    expect(june[0].date.getDate()).toBe(1);
    expect(june[june.length - 1].date.getDate()).toBe(30);
    // Every inMonth cell is actually in the requested month/year.
    for (const c of june) {
      expect(c.date.getMonth()).toBe(5);
      expect(c.date.getFullYear()).toBe(2026);
    }
  });

  test("a month NOT starting on Monday has leading padding days", () => {
    // August 2026 starts on a Saturday → leading Mon-Fri are July padding.
    const cells = buildCalendarMonth(2026, 7);
    expect(cells[0].inMonth).toBe(false);
    expect(cells[0].date.getMonth()).toBe(6); // July
    expect(cells.find((c) => c.inMonth)!.date.getDate()).toBe(1);
  });

  test("the grid starts on a Monday", () => {
    const cells = buildCalendarMonth(2026, 5);
    // getDay(): Monday = 1.
    expect(cells[0].date.getDay()).toBe(1);
  });
});

describe("groupPostsByDay — buckets + unscheduled", () => {
  const drafts = [
    draft({ id: "a", planToPostOn: "2026-06-10", status: "ready" }),
    draft({ id: "b", planToPostOn: "2026-06-10", status: "idea" }),
    draft({ id: "c", planToPostOn: "2026-06-12" }),
    draft({ id: "d", planToPostOn: null }), // unscheduled
    draft({ id: "e", planToPostOn: null, kind: "hook" }),
  ];

  test("dated posts bucket by their day; undated go to unscheduled", () => {
    const { byDay, unscheduled } = groupPostsByDay(drafts, "", "all");
    expect(byDay["2026-06-10"].map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(byDay["2026-06-12"].map((p) => p.id)).toEqual(["c"]);
    expect(unscheduled.map((p) => p.id).sort()).toEqual(["d", "e"]);
  });

  test("kind filter applies (hooks only)", () => {
    const { byDay, unscheduled } = groupPostsByDay(drafts, "", "hook");
    expect(Object.keys(byDay)).toHaveLength(0); // no dated hooks
    expect(unscheduled.map((p) => p.id)).toEqual(["e"]);
  });

  test("search query filters by title/body", () => {
    const list = [
      draft({ id: "x", title: "Cold outreach", planToPostOn: "2026-06-10" }),
      draft({ id: "y", title: "GTM post", planToPostOn: "2026-06-11" }),
    ];
    const { byDay } = groupPostsByDay(list, "outreach", "all");
    expect(byDay["2026-06-10"].map((p) => p.id)).toEqual(["x"]);
    expect(byDay["2026-06-11"]).toBeUndefined();
  });
});
