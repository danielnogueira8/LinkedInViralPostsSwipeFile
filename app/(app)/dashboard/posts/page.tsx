import { currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { DraftsList, type DraftStatus, type Draft } from "./drafts-list";
import { leadMagnetContextFromMeta } from "@/lib/draft-lead-magnet";
import { getPrimaryPendingReviewQueue } from "@/lib/posts-next-action";
import type { PostPreviewAuthor } from "../draft-editor-modal";
import { PageHeader, PageShell } from "@/components/app-surface";
import {
  REVIEW_DRAFT_COLS,
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

  const draftsPromise = sb.raw
    .from("chat_artifacts")
    .select(REVIEW_DRAFT_COLS)
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);
  const voicePromise = sb.raw
    .from("voice_profiles")
    .select("display_name, avatar_url, headline")
    .eq("workspace_id", sb.workspaceId)
    .maybeSingle();
  const userPromise = currentUser();

  const [{ data: drafts }, { data: voice }, user] = await Promise.all([
    draftsPromise,
    voicePromise,
    userPromise,
  ]);

  const clerkName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username ||
    "You";
  const author: PostPreviewAuthor = {
    name: (voice?.display_name as string | null) || clerkName,
    avatarUrl: (voice?.avatar_url as string | null) || user?.imageUrl || null,
    headline: (voice?.headline as string | null) || null,
  };

  // Split by status: only board-status drafts render here. Weekly-batch drafts
  // awaiting review ('pending_review') and rejected drafts stay OFF this page
  // entirely — batch review moved to Cowork's batch chat, where each draft
  // card carries its own Approve / Reject / Edit buttons.
  const board: Draft[] = [];
  const rows = (drafts ?? []) as DraftRow[];
  const pendingReview = getPrimaryPendingReviewQueue(rows);
  for (const row of rows) {
    if (isBoardStatus(row.status)) {
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
        leadMagnet: leadMagnetContextFromMeta(row.meta),
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
    // else: 'pending_review' / 'rejected' / unknown → not surfaced here.
    // pending_review drafts live in Cowork's batch chat now (see PR).
  }
  return (
    <PageShell width="wide">
      <PageHeader
        title="Posts"
        description="Review, schedule, and track your LinkedIn posts."
      />
      <DraftsList
        initialDrafts={board}
        author={author}
        pendingReview={pendingReview}
      />
    </PageShell>
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
