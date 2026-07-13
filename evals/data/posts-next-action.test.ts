import { describe, expect, test } from "vitest";
import {
  getPostsNextAction,
  getPrimaryPendingReviewQueue,
} from "@/lib/posts-next-action";

describe("getPrimaryPendingReviewQueue", () => {
  test("counts only the newest reviewable batch", () => {
    expect(
      getPrimaryPendingReviewQueue([
        { status: "pending_review", chat_id: "new-batch" },
        { status: "pending_review", chat_id: "new-batch" },
        { status: "pending_review", chat_id: "old-batch" },
      ]),
    ).toEqual({ count: 2, chatId: "new-batch" });
  });

  test("ignores headless pending rows that have no Cowork destination", () => {
    expect(
      getPrimaryPendingReviewQueue([
        { status: "pending_review", chat_id: null },
        { status: "ready", chat_id: "chat-1" },
      ]),
    ).toBeNull();
  });
});

describe("getPostsNextAction", () => {
  test("prioritizes drafts waiting for review and links to their Cowork batch", () => {
    expect(
      getPostsNextAction({
        pendingReview: { count: 2, chatId: "chat 1" },
        readyDraftIds: ["ready-1"],
        unfinishedDraftIds: ["draft-1"],
      }),
    ).toEqual({
      kind: "review",
      label: "Review 2 drafts",
      detail: "Clear the drafts waiting for your decision.",
      href: "/dashboard?chat=chat%201",
    });
  });

  test("opens the next ready post when nothing needs review", () => {
    expect(
      getPostsNextAction({
        pendingReview: null,
        readyDraftIds: ["ready-1", "ready-2"],
        unfinishedDraftIds: ["draft-1"],
      }),
    ).toMatchObject({
      kind: "schedule",
      label: "Schedule 2 ready posts",
      draftId: "ready-1",
    });
  });

  test("continues unfinished work before offering a new post", () => {
    expect(
      getPostsNextAction({
        pendingReview: null,
        readyDraftIds: [],
        unfinishedDraftIds: ["draft-1"],
      }),
    ).toMatchObject({
      kind: "continue",
      label: "Continue 1 unfinished draft",
      draftId: "draft-1",
    });
  });

  test("offers creation only when the actionable pipeline is empty", () => {
    expect(
      getPostsNextAction({
        pendingReview: null,
        readyDraftIds: [],
        unfinishedDraftIds: [],
      }),
    ).toEqual({
      kind: "create",
      label: "Create your next post",
      detail: "Start a new draft with Cowork.",
      href: "/dashboard",
    });
  });
});
