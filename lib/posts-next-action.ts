export type PostsNextAction =
  | { kind: "review"; label: string; detail: string; href: string }
  | { kind: "schedule" | "continue"; label: string; detail: string; draftId: string }
  | { kind: "create"; label: string; detail: string; href: string };

export type PendingReviewQueue = { count: number; chatId: string };

export function getPostsActionCandidates(
  drafts: {
    id: string;
    status: string;
    scheduledAt?: string | null;
    scheduleStatus?: string | null;
  }[],
): { readyDraftIds: string[]; unfinishedDraftIds: string[] } {
  const isCommitted = (scheduleStatus: string | null | undefined) =>
    scheduleStatus === "scheduled" ||
    scheduleStatus === "publishing" ||
    scheduleStatus === "published";

  return {
    readyDraftIds: drafts
      .filter(
        (draft) =>
          draft.status === "ready" &&
          (!draft.scheduledAt || draft.scheduleStatus === "failed") &&
          !isCommitted(draft.scheduleStatus),
      )
      .map((draft) => draft.id),
    unfinishedDraftIds: drafts
      .filter(
        (draft) =>
          (draft.status === "idea" || draft.status === "drafting") &&
          !isCommitted(draft.scheduleStatus),
      )
      .map((draft) => draft.id),
  };
}

// The Posts query supplies rows newest-first, so the first reviewable chat is
// the most recent batch the user can act on.
export function getFirstPendingReviewQueue(
  rows: { status: string | null; chat_id: string | null }[],
): PendingReviewQueue | null {
  const firstReview = rows.find(
    (row) => row.status === "pending_review" && row.chat_id,
  );
  if (!firstReview?.chat_id) return null;

  return {
    chatId: firstReview.chat_id,
    count: rows.filter(
      (row) => row.status === "pending_review" && row.chat_id === firstReview.chat_id,
    ).length,
  };
}

export function getPostsNextAction({
  pendingReview,
  readyDraftIds,
  unfinishedDraftIds,
}: {
  pendingReview: PendingReviewQueue | null;
  readyDraftIds: string[];
  unfinishedDraftIds: string[];
}): PostsNextAction {
  if (pendingReview) {
    return {
      kind: "review",
      label: `Review ${pendingReview.count} ${pendingReview.count === 1 ? "draft" : "drafts"}`,
      detail: "Clear the drafts waiting for your decision.",
      href: `/dashboard?chat=${encodeURIComponent(pendingReview.chatId)}`,
    };
  }

  if (readyDraftIds.length > 0) {
    return {
      kind: "schedule",
      label: `Schedule ${readyDraftIds.length} ready ${readyDraftIds.length === 1 ? "post" : "posts"}`,
      detail: "Choose a publish time for the next ready post.",
      draftId: readyDraftIds[0],
    };
  }

  if (unfinishedDraftIds.length > 0) {
    return {
      kind: "continue",
      label: `Continue ${unfinishedDraftIds.length} unfinished ${unfinishedDraftIds.length === 1 ? "draft" : "drafts"}`,
      detail: "Open the next draft and move it toward Ready.",
      draftId: unfinishedDraftIds[0],
    };
  }

  return {
    kind: "create",
    label: "Create your next post",
    detail: "Start a new draft with Cowork.",
    href: "/dashboard",
  };
}
