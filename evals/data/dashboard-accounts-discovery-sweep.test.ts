import { describe, expect, test } from "vitest";
import {
  reconcileBookmarkGridPage,
  type BookmarkGridReconciliationInput,
} from "@/app/(app)/dashboard/bookmarks/bookmarks-grid-state";
import type { BookmarkCard } from "@/lib/bookmarks-query";

function card(id: string): BookmarkCard {
  return {
    row: {
      id,
      post_url: `https://www.linkedin.com/posts/${id}`,
      activity_id: id,
      embed_urn: null,
      author_name: "Creator",
      author_handle: "creator",
      text_snippet: null,
      text: "Post",
      profile_pic_url: null,
      media_type: "none",
      media_urls: [],
      video_url: null,
      reactions: 1,
      comments: 1,
      note: null,
      category_id: null,
      post_type: "regular",
      posted_at: "2026-07-31T00:00:00.000Z",
      saved_at: "2026-07-31T00:00:00.000Z",
    },
    categoryLabel: null,
    contributorName: null,
  };
}

function reconcile(
  input: Partial<BookmarkGridReconciliationInput> &
    Pick<BookmarkGridReconciliationInput, "currentCards" | "serverCards">,
) {
  return reconcileBookmarkGridPage({
    serverNextOffset: null,
    ...input,
  });
}

describe("dashboard bookmark discovery sweep", () => {
  test("adds fresh first-page rows without clobbering appended rows", () => {
    const result = reconcile({
      currentCards: [card("first"), card("loaded-later")],
      serverCards: [card("new-first"), card("first")],
      serverNextOffset: 24,
    });

    expect(result.cards.map((item) => item.row.id)).toEqual([
      "new-first",
      "first",
      "loaded-later",
    ]);
  });

  test("refreshing a full first page updates a cursor that became exhausted", () => {
    const result = reconcile({
      currentCards: [card("first"), card("second")],
      serverCards: [card("first"), card("second"), card("replacement")],
      serverNextOffset: null,
    });

    expect(result.nextOffset).toBeNull();
  });
});
