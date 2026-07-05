import { scopedSupabase } from "@/lib/supabase-scoped";
import { DraftsList, type DraftStatus, type Draft } from "./drafts-list";
import { GenerateBatchButton } from "./generate-batch-button";
import { BatchReviewPanel, type ReviewDraft } from "./batch-review-panel";
import {
  REVIEW_DRAFT_COLS,
  toReviewDraft,
  sourceUrlFromMeta as sourceUrlFromMetaShared,
  type ReviewDraftRow,
} from "@/lib/batch/review-draft";

// Saved posts — the drafts the user kept via "Save draft" in the chat, plus any
// authored on the board (rows in chat_artifacts). Rendered as a Notion-style
// pipeline board: each card is the post's name; clicking it opens a detail
// drawer to edit the body, status, due date, and name.

export const dynamic = "force-dynamic";

// The row shape both surfaces read. Aliased to the shared ReviewDraftRow so the
// board mapping (below) and the review mapping (lib/batch/review-draft) stay in
// lockstep.
type DraftRow = ReviewDraftRow;

export default async function DraftsPage() {
  const sb = await scopedSupabase();

  const { data: drafts } = await sb.raw
    .from("chat_artifacts")
    .select(REVIEW_DRAFT_COLS)
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);

  // Split by status: weekly-batch drafts awaiting review ('pending_review') go
  // to the review panel; the four pipeline stages render on the board. Anything
  // else ('rejected', or a stray value) is dropped from BOTH — off-board and
  // out of review, so nothing unvetted leaks onto the pipeline.
  const board: Draft[] = [];
  const review: ReviewDraft[] = [];
  for (const d of drafts ?? []) {
    const row = d as DraftRow;
    if (row.status === "pending_review") {
      // Shared mapper — the SAME builder the live-poll endpoint uses, so a
      // freshly-polled draft dedups cleanly against this first-paint one.
      review.push(toReviewDraft(row));
    } else if (isBoardStatus(row.status)) {
      board.push({
        id: row.id,
        title: row.title,
        body: row.body,
        kind: (row.kind === "hook" || row.kind === "lead_magnet"
          ? row.kind
          : "post") as Draft["kind"],
        status: row.status,
        planToPostOn: row.plan_to_post_on,
        chatId: row.chat_id,
        createdAt: row.created_at,
        sourceUrl: sourceUrlFromMetaShared(row.meta),
        scheduledAt: row.scheduled_at,
        scheduleStatus: row.schedule_status as Draft["scheduleStatus"],
        firstComment: row.first_comment,
        publishedAt: row.published_at,
        publishError: row.publish_error,
        mediaAttachments: Array.isArray(row.media_attachments)
          ? (row.media_attachments as Draft["mediaAttachments"])
          : [],
      });
    }
    // else: 'rejected' / unknown → neither surface.
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Posts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your content pipeline. Drag a card to move it from idea to posted, or
            open it to edit, schedule, and copy.
          </p>
        </div>
        {/* On-demand weekly batch: finds this week's top posts, drafts them in
            your voice — they land in the review panel below before your board. */}
        <GenerateBatchButton />
      </div>
      {/* Review gate: batch drafts wait here for your OK before joining the board. */}
      <BatchReviewPanel initial={review} />
      <DraftsList initialDrafts={board} />
    </div>
  );
}

// True when a raw status is one of the four board pipeline stages.
function isBoardStatus(s: string | null | undefined): s is DraftStatus {
  return s === "idea" || s === "drafting" || s === "ready" || s === "posted";
}

// Re-exported from the shared mapper so the existing test import
// (@/app/(app)/dashboard/posts/page) keeps resolving. The implementation now
// lives in lib/batch/review-draft alongside the row→ReviewDraft mapping.
export { sourceUrlFromMeta } from "@/lib/batch/review-draft";
