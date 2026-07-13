import { describe, expect, test } from "vitest";
import {
  getPostsNextAction,
  getPostsActionCandidates,
  getFirstPendingReviewQueue,
} from "@/lib/posts-next-action";

describe("getFirstPendingReviewQueue", () => {
  test("counts only the newest reviewable batch", () => {
    expect(
      getFirstPendingReviewQueue([
        { status: "pending_review", chat_id: "new-batch" },
        { status: "pending_review", chat_id: "new-batch" },
        { status: "pending_review", chat_id: "old-batch" },
      ]),
    ).toEqual({ count: 2, chatId: "new-batch" });
  });

  test("ignores headless pending rows that have no Cowork destination", () => {
    expect(
      getFirstPendingReviewQueue([
        { status: "pending_review", chat_id: null },
        { status: "ready", chat_id: "chat-1" },
      ]),
    ).toBeNull();
  });
});

describe("getPostsActionCandidates", () => {
  test("excludes scheduled work from ready and unfinished actions", () => {
    expect(
      getPostsActionCandidates([
        { id: "scheduled-ready", status: "ready", scheduleStatus: "scheduled" },
        { id: "scheduled-draft", status: "drafting", scheduleStatus: "scheduled" },
        { id: "draft", status: "drafting", scheduleStatus: null },
      ]),
    ).toEqual({ readyDraftIds: [], unfinishedDraftIds: ["draft"] });
  });

  test("keeps failed ready posts actionable for rescheduling", () => {
    expect(
      getPostsActionCandidates([
        {
          id: "failed",
          status: "ready",
          scheduledAt: "2026-07-13T12:00:00.000Z",
          scheduleStatus: "failed",
        },
      ]),
    ).toEqual({ readyDraftIds: ["failed"], unfinishedDraftIds: [] });
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
      label: "Choose publish time for 2 ready posts",
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
      label: "Write your next post",
      detail: "Cowork will help turn your idea into a draft.",
      href: "/dashboard",
    });
  });
});
