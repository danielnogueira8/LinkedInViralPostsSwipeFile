import { describe, test, expect } from "vitest";
import {
  groupDraftsForBoard,
  columnCollapse,
  mergeServerDrafts,
  COLUMN_PREVIEW_COUNT,
  type Draft,
} from "@/app/(app)/dashboard/posts/drafts-list";

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

describe("mergeServerDrafts — live board reconcile (batch drafts appear w/o reload)", () => {
  test("prepends server drafts missing locally (the freshly-filed batch cards)", () => {
    const cur = [draft({ id: "a" })];
    const server = [draft({ id: "batch2" }), draft({ id: "batch1" }), draft({ id: "a" })];
    const out = mergeServerDrafts(cur, server);
    // New ones come in newest-first, existing local card kept.
    expect(ids(out)).toEqual(["batch2", "batch1", "a"]);
  });

  test("nothing new → returns the SAME reference (no needless re-render)", () => {
    const cur = [draft({ id: "a" }), draft({ id: "b" })];
    const server = [draft({ id: "a" })]; // subset, no additions
    expect(mergeServerDrafts(cur, server)).toBe(cur);
  });

  test("keeps a local-only draft not yet on the server (unsaved new card)", () => {
    const cur = [draft({ id: "local-new" })];
    const server = [draft({ id: "s1" })];
    const out = mergeServerDrafts(cur, server);
    expect(ids(out)).toContain("local-new");
    expect(ids(out)).toContain("s1");
  });

  test("does NOT clobber an existing local card's fields (add-only)", () => {
    const cur = [draft({ id: "a", title: "my local edit", status: "ready" })];
    const server = [draft({ id: "a", title: "stale server title", status: "idea" })];
    const out = mergeServerDrafts(cur, server);
    // 'a' already exists locally → kept as-is, server copy ignored.
    expect(out.find((d) => d.id === "a")?.title).toBe("my local edit");
    expect(out.find((d) => d.id === "a")?.status).toBe("ready");
  });
});

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

// ---------------------------------------------------------------------------
// normalizeDraft — coerces a loose API row (strings from JSON) into the board's
// Draft shape. Guards the create-on-page + edit-modal handoff: a malformed kind
// or status from the server must never crash the board or land in a phantom
// column.
// ---------------------------------------------------------------------------
import { normalizeDraft } from "@/app/(app)/dashboard/draft-editor-modal";

describe("normalizeDraft — API row → board Draft", () => {
  const row = {
    id: "d1",
    title: "Hello",
    body: "Body text",
    kind: "post",
    status: "idea",
    plan_to_post_on: "2026-07-01",
    chat_id: null,
    created_at: "2026-06-26T00:00:00.000Z",
  };

  test("maps snake_case columns to the camelCase Draft fields", () => {
    expect(normalizeDraft(row)).toEqual({
      id: "d1",
      title: "Hello",
      body: "Body text",
      kind: "post",
      status: "idea",
      planToPostOn: "2026-07-01",
      chatId: null,
      createdAt: "2026-06-26T00:00:00.000Z",
    });
  });

  test("an unknown status falls back to 'idea' (never a phantom column)", () => {
    expect(normalizeDraft({ ...row, status: "archived" }).status).toBe("idea");
    expect(normalizeDraft({ ...row, status: "" }).status).toBe("idea");
  });

  test("any non-'hook' kind normalizes to 'post'", () => {
    expect(normalizeDraft({ ...row, kind: "hook" }).kind).toBe("hook");
    expect(normalizeDraft({ ...row, kind: "weird" }).kind).toBe("post");
  });

  test("a board-authored draft (chat_id null) is preserved, not coerced", () => {
    expect(normalizeDraft({ ...row, chat_id: null }).chatId).toBeNull();
    expect(normalizeDraft({ ...row, chat_id: "c9" }).chatId).toBe("c9");
  });
});

// ---------------------------------------------------------------------------
// defaultDraftStatus — the pipeline stage a board-authored draft lands in when
// no status is given. Locks the convention (full post → drafting, hook → idea)
// so POST /api/drafts can't drift back to dumping every new post in "idea".
// Mirrors the chat-save path (app/api/chats/[id]/artifacts).
// ---------------------------------------------------------------------------
import { defaultDraftStatus } from "@/app/api/drafts/route";

describe("defaultDraftStatus — kind → pipeline stage", () => {
  test("a full post starts in 'drafting' (the Drafting column), not 'idea'", () => {
    expect(defaultDraftStatus("post")).toBe("drafting");
  });
  test("a hook starts in 'idea' (the Ideas & hooks column)", () => {
    expect(defaultDraftStatus("hook")).toBe("idea");
  });
});
