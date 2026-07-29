import {
  BOARD_DRAFT_STATUSES,
  type BoardDraftStatus,
  type DraftRecord,
} from "@/lib/draft-lifecycle";

export type ExistingQueueBooking = {
  status: BoardDraftStatus;
  scheduledAt: string;
  scheduleStatus: "scheduled" | "publishing";
  planToPostOn: string | null;
  firstComment: string | null;
  postingSlotId: string;
  postingSlotOccurrenceDate: string;
};

export function existingQueueBooking(
  draft: DraftRecord | null,
): ExistingQueueBooking | null {
  if (
    !draft ||
    (draft.scheduleStatus !== "scheduled" &&
      draft.scheduleStatus !== "publishing") ||
    !draft.scheduledAt ||
    !draft.postingSlotId ||
    !draft.postingSlotOccurrenceDate ||
    !(BOARD_DRAFT_STATUSES as readonly string[]).includes(draft.status)
  ) {
    return null;
  }

  return {
    status: draft.status as BoardDraftStatus,
    scheduledAt: draft.scheduledAt,
    scheduleStatus: draft.scheduleStatus,
    planToPostOn: draft.planToPostOn,
    firstComment: draft.firstComment,
    postingSlotId: draft.postingSlotId,
    postingSlotOccurrenceDate: draft.postingSlotOccurrenceDate,
  };
}
