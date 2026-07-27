import { describe, test, expect } from "vitest";
import {
  groupDraftsForBoard,
  columnCollapse,
  mergeServerDrafts,
  boardColumnForDraft,
  adjacentDraftIds,
  COLUMN_PREVIEW_COUNT,
  type Draft,
} from "@/app/(app)/dashboard/posts/drafts-list";
import { leadMagnetContextFromMeta } from "@/lib/draft-lead-magnet";

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

describe("adjacentDraftIds — edit-dialog navigation", () => {
  const drafts = [draft({ id: "first" }), draft({ id: "middle" }), draft({ id: "last" })];

  test("returns the immediately adjacent posts in board order", () => {
    expect(adjacentDraftIds(drafts, "middle")).toEqual({
      previousId: "first",
      nextId: "last",
    });
  });

  test("has no previous/next post at the corresponding boundaries", () => {
    expect(adjacentDraftIds(drafts, "first")).toEqual({
      previousId: null,
      nextId: "middle",
    });
    expect(adjacentDraftIds(drafts, "last")).toEqual({
      previousId: "middle",
      nextId: null,
    });
  });

  test("does not navigate when there is no current board post", () => {
    expect(adjacentDraftIds(drafts, null)).toEqual({ previousId: null, nextId: null });
    expect(adjacentDraftIds(drafts, "removed")).toEqual({ previousId: null, nextId: null });
  });
});

describe("groupDraftsForBoard — grouping by status", () => {
  test("each unscheduled draft lands in exactly its status column", () => {
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
    expect(ids(g.scheduled)).toEqual([]);
    expect(ids(g.posted)).toEqual(["d"]);
  });

  test("scheduled and publishing drafts land in the derived Scheduled lane", () => {
    const g = groupDraftsForBoard(
      [
        draft({ id: "scheduled", status: "ready", scheduleStatus: "scheduled" }),
        draft({ id: "publishing", status: "ready", scheduleStatus: "publishing" }),
      ],
      "",
      "all",
    );
    expect(ids(g.ready)).toEqual([]);
    expect(ids(g.scheduled)).toEqual(["scheduled", "publishing"]);
  });

  test("published schedules land in Posted even before a refreshed status arrives", () => {
    const g = groupDraftsForBoard(
      [draft({ id: "published", status: "ready", scheduleStatus: "published" })],
      "",
      "all",
    );
    expect(ids(g.ready)).toEqual([]);
    expect(ids(g.posted)).toEqual(["published"]);
  });

  test("failed schedules stay in their real pipeline stage", () => {
    const g = groupDraftsForBoard(
      [draft({ id: "failed", status: "ready", scheduleStatus: "failed" })],
      "",
      "all",
    );
    expect(ids(g.ready)).toEqual(["failed"]);
    expect(ids(g.scheduled)).toEqual([]);
  });

  test("always returns all five display lanes, even when empty", () => {
    const g = groupDraftsForBoard([], "", "all");
    expect(Object.keys(g).sort()).toEqual(["drafting", "idea", "posted", "ready", "scheduled"]);
    expect(g.idea).toEqual([]);
  });
});

// Bug-hunt fix (task #187): applyMeta's mobile-column selector used to fall
// back to a `drafts` CLOSURE snapshot (potentially stale by the time an async
// caller's response lands) instead of the merged draft's real status. The fix
// routes the mobile column through boardColumnForDraft — the SAME function
// that already derives the desktop grouping — applied to the freshly-merged
// draft. These pin the exact scenario from the bug: a schedule cancellation
// (scheduleStatus -> null) with no accompanying status change in the patch.
describe("boardColumnForDraft — single source of truth for board/mobile column", () => {
  test("a cancelled schedule (scheduleStatus -> null) resolves to the draft's OWN current status", () => {
    // This is the merged draft applyMeta computes: { ...current, ...patch }
    // where patch = { scheduleStatus: null } and current.status is 'drafting'
    // (NOT 'idea' — a stale snapshot from a prior render would wrongly say
    // 'idea' if it read an outdated closure instead of the merged draft).
    const merged = draft({ id: "d1", status: "drafting", scheduleStatus: null });
    expect(boardColumnForDraft(merged)).toBe("drafting");
  });

  test("a patch with BOTH a status change and scheduleStatus->scheduled prefers the schedule lane", () => {
    // scheduling always wins over a stale/simultaneous status field — matches
    // the desktop grouping's precedence (scheduleStatus checked first).
    const merged = draft({ id: "d1", status: "posted", scheduleStatus: "scheduled" });
    expect(boardColumnForDraft(merged)).toBe("scheduled");
  });

  test("scheduled/publishing map to the Scheduled lane; published maps to Posted", () => {
    expect(
      boardColumnForDraft(draft({ id: "a", status: "ready", scheduleStatus: "scheduled" })),
    ).toBe("scheduled");
    expect(
      boardColumnForDraft(draft({ id: "b", status: "ready", scheduleStatus: "publishing" })),
    ).toBe("scheduled");
    expect(
      boardColumnForDraft(draft({ id: "c", status: "ready", scheduleStatus: "published" })),
    ).toBe("posted");
  });

  test("no scheduleStatus (null/undefined/'failed') falls through to the draft's real status", () => {
    expect(boardColumnForDraft(draft({ id: "a", status: "ready" }))).toBe("ready");
    expect(
      boardColumnForDraft(draft({ id: "b", status: "ready", scheduleStatus: "failed" })),
    ).toBe("ready");
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
import { normalizeDraft } from "@/lib/draft-view";

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
    meta: null,
    media_attachments: [],
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
      leadMagnet: null,
      // meta is surfaced onto the Draft (only `markdown` is read client-side).
      // A null/absent row meta normalizes to null.
      meta: null,
      mediaAttachments: [],
    });
  });

  test("a markdown-model draft surfaces meta.markdown onto the Draft", () => {
    // The field that lets the modal copy / publish normalize the body.
    expect(normalizeDraft({ ...row, meta: { markdown: true } }).meta).toEqual({
      markdown: true,
    });
  });

  test("maps lead magnet metadata onto the Draft context", () => {
    expect(
      normalizeDraft({
        ...row,
        meta: {
          lead_magnet: {
            title: "Founder Content Checklist",
            selection: "manual",
          },
        },
      }).leadMagnet,
    ).toEqual({
      title: "Founder Content Checklist",
      selection: "manual",
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

  test("a giveaway (meta.lead_magnet) upgrades a 'post' row to lead_magnet", () => {
    // Rows written before the giveaway⇒lead_magnet rule existed carry
    // kind='post' with the giveaway in meta — display them as lead magnets.
    const withGiveaway = {
      ...row,
      kind: "post",
      meta: { lead_magnet: { title: "5 Prompts", selection: "auto" } },
    };
    expect(normalizeDraft(withGiveaway).kind).toBe("lead_magnet");
    // A hook is never promoted, and a lead_magnet row stays lead_magnet.
    expect(normalizeDraft({ ...withGiveaway, kind: "hook" }).kind).toBe("hook");
    expect(normalizeDraft({ ...withGiveaway, kind: "lead_magnet" }).kind).toBe(
      "lead_magnet",
    );
    // A malformed giveaway stamp doesn't flip the kind.
    expect(
      normalizeDraft({ ...row, meta: { lead_magnet: { title: "" } } }).kind,
    ).toBe("post");
  });

  test("a board-authored draft (chat_id null) is preserved, not coerced", () => {
    expect(normalizeDraft({ ...row, chat_id: null }).chatId).toBeNull();
    expect(normalizeDraft({ ...row, chat_id: "c9" }).chatId).toBe("c9");
  });
});

describe("leadMagnetContextFromMeta", () => {
  test("extracts the selected giveaway from artifact metadata", () => {
    expect(
      leadMagnetContextFromMeta({
        lead_magnet: {
          id: "lm_1",
          title: "Hook Audit Checklist",
          selection: "auto",
        },
      }),
    ).toEqual({ title: "Hook Audit Checklist", selection: "auto" });
  });

  test("rejects malformed or absent metadata", () => {
    expect(leadMagnetContextFromMeta(null)).toBeNull();
    expect(leadMagnetContextFromMeta({ lead_magnet: { title: "" } })).toBeNull();
    expect(leadMagnetContextFromMeta({ lead_magnet: "bad" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// defaultDraftStatus — the pipeline stage a board-authored draft lands in when
// no status is given. Locks the convention (full post → drafting, hook → idea)
// so POST /api/drafts can't drift back to dumping every new post in "idea".
// Mirrors the chat-save path (app/api/chats/[id]/artifacts).
// ---------------------------------------------------------------------------
import { defaultDraftStatus } from "@/lib/draft-lifecycle";

describe("defaultDraftStatus — kind → pipeline stage", () => {
  test("a full post starts in 'drafting' (the Drafting column), not 'idea'", () => {
    expect(defaultDraftStatus("post")).toBe("drafting");
  });
  test("a hook starts in 'idea' (the Ideas column)", () => {
    expect(defaultDraftStatus("hook")).toBe("idea");
  });
  test("a lead magnet post starts in 'drafting'", () => {
    expect(defaultDraftStatus("lead_magnet")).toBe("drafting");
  });
});
