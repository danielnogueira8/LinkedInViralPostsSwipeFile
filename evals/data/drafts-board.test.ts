import { describe, test, expect } from "vitest";
import {
  groupDraftsForBoard,
  columnCollapse,
  COLUMN_PREVIEW_COUNT,
  type Draft,
} from "@/app/(app)/dashboard/drafts/drafts-list";

// ---------------------------------------------------------------------------
// Unit tests for the drafts pipeline board's grouping/filter/sort — the pure
// model behind the kanban view (migration 047). Hermetic, no DOM.
// ---------------------------------------------------------------------------

function draft(p: Partial<Draft> & { id: string }): Draft {
  return {
    title: null,
    body: "",
    kind: "post",
    status: "drafting",
    planToPostOn: null,
    chatId: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...p,
  };
}

const ids = (xs: Draft[]) => xs.map((d) => d.id);

describe("groupDraftsForBoard — grouping by status", () => {
  test("each draft lands in exactly its status column", () => {
    const g = groupDraftsForBoard(
      [
        draft({ id: "a", status: "idea" }),
        draft({ id: "b", status: "drafting" }),
        draft({ id: "c", status: "ready" }),
        draft({ id: "d", status: "posted" }),
      ],
      "",
      "all",
    );
    expect(ids(g.idea)).toEqual(["a"]);
    expect(ids(g.drafting)).toEqual(["b"]);
    expect(ids(g.ready)).toEqual(["c"]);
    expect(ids(g.posted)).toEqual(["d"]);
  });

  test("always returns all four columns, even when empty", () => {
    const g = groupDraftsForBoard([], "", "all");
    expect(Object.keys(g).sort()).toEqual(["drafting", "idea", "posted", "ready"]);
    expect(g.idea).toEqual([]);
  });
});

describe("groupDraftsForBoard — filters", () => {
  test("kind filter keeps only matching kind", () => {
    const drafts = [
      draft({ id: "p", kind: "post", status: "drafting" }),
      draft({ id: "h", kind: "hook", status: "drafting" }),
    ];
    expect(ids(groupDraftsForBoard(drafts, "", "post").drafting)).toEqual(["p"]);
    expect(ids(groupDraftsForBoard(drafts, "", "hook").drafting)).toEqual(["h"]);
    expect(ids(groupDraftsForBoard(drafts, "", "all").drafting)).toEqual(["p", "h"]);
  });

  test("search matches title OR body, case-insensitively", () => {
    const drafts = [
      draft({ id: "t", title: "Cold Email Tips", body: "irrelevant" }),
      draft({ id: "b", title: null, body: "a post about COLD outreach" }),
      draft({ id: "n", title: "Other", body: "nothing here" }),
    ];
    const g = groupDraftsForBoard(drafts, "cold", "all");
    expect(ids(g.drafting).sort()).toEqual(["b", "t"]);
  });

  test("empty query matches everything", () => {
    const drafts = [draft({ id: "a" }), draft({ id: "b" })];
    expect(groupDraftsForBoard(drafts, "   ", "all").drafting.length).toBe(2);
  });
});

describe("groupDraftsForBoard — sort within a column", () => {
  test("planned dates sort soonest-first, ahead of undated", () => {
    const g = groupDraftsForBoard(
      [
        draft({ id: "undated" }),
        draft({ id: "later", planToPostOn: "2026-07-10" }),
        draft({ id: "soon", planToPostOn: "2026-06-28" }),
      ],
      "",
      "all",
    );
    expect(ids(g.drafting)).toEqual(["soon", "later", "undated"]);
  });

  test("undated cards fall back to recency (newest first)", () => {
    const g = groupDraftsForBoard(
      [
        draft({ id: "old", createdAt: "2026-06-01T00:00:00.000Z" }),
        draft({ id: "new", createdAt: "2026-06-20T00:00:00.000Z" }),
      ],
      "",
      "all",
    );
    expect(ids(g.drafting)).toEqual(["new", "old"]);
  });
});

describe("columnCollapse — Notion-style show-more threshold", () => {
  test(`<= ${COLUMN_PREVIEW_COUNT} cards: show all, no overflow toggle`, () => {
    expect(columnCollapse(0, false)).toEqual({ visibleCount: 0, overflow: 0 });
    expect(columnCollapse(1, false)).toEqual({ visibleCount: 1, overflow: 0 });
    expect(columnCollapse(COLUMN_PREVIEW_COUNT, false)).toEqual({
      visibleCount: COLUMN_PREVIEW_COUNT,
      overflow: 0,
    });
  });

  test("more than the threshold, collapsed: show only the preview count + overflow", () => {
    expect(columnCollapse(COLUMN_PREVIEW_COUNT + 1, false)).toEqual({
      visibleCount: COLUMN_PREVIEW_COUNT,
      overflow: 1,
    });
    expect(columnCollapse(20, false)).toEqual({
      visibleCount: COLUMN_PREVIEW_COUNT,
      overflow: 20 - COLUMN_PREVIEW_COUNT,
    });
  });

  test("expanded: show all, but overflow still reports the hidden-when-collapsed count", () => {
    // overflow stays > 0 so the toggle stays rendered (as "Show less").
    expect(columnCollapse(20, true)).toEqual({
      visibleCount: 20,
      overflow: 20 - COLUMN_PREVIEW_COUNT,
    });
  });
});
