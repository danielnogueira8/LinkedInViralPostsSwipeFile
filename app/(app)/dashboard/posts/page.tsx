import { currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { DraftsList, type DraftStatus, type Draft } from "./drafts-list";
import { leadMagnetContextFromMeta } from "@/lib/draft-lead-magnet";
import { BatchReviewPanel, type ReviewDraft } from "./batch-review-panel";
import type { PostPreviewAuthor } from "../draft-editor-modal";
import { PageHeader, PageShell, Surface } from "@/components/app-surface";
import Link from "next/link";
import { CalendarClock, ClipboardCheck, Handshake } from "lucide-react";
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
    // else: 'rejected' / unknown → neither surface.
  }
  const readyUnscheduledCount = board.filter(
    (draft) => draft.status === "ready" && !draft.scheduledAt,
  ).length;

  return (
    <PageShell width="wide">
      <PageHeader
        title="Posts"
        description="Review, schedule, and track your LinkedIn posts."
      />
      <ExecutionActions
        pendingReviewCount={review.length}
        readyUnscheduledCount={readyUnscheduledCount}
      />
      {/* Review gate: batch drafts wait here for your OK before joining the board. */}
      <BatchReviewPanel initial={review} author={author} />
      <DraftsList initialDrafts={board} author={author} />
    </PageShell>
  );
}

function ExecutionActions({
  pendingReviewCount,
  readyUnscheduledCount,
}: {
  pendingReviewCount: number;
  readyUnscheduledCount: number;
}) {
  const actions = [
    {
      href: "/dashboard/posts",
      label: "Review drafts",
      detail:
        pendingReviewCount > 0
          ? `${pendingReviewCount} waiting`
          : "approve batch drafts",
      icon: ClipboardCheck,
    },
    {
      href: "/dashboard/posts",
      label: "Schedule ready posts",
      detail:
        readyUnscheduledCount > 0
          ? `${readyUnscheduledCount} unscheduled`
          : "pick publish times",
      icon: CalendarClock,
    },
    {
      href: "/dashboard",
      label: "Start in Cowork",
      detail: "write the next draft",
      icon: Handshake,
    },
  ];

  return (
    <Surface tone="flat" padding="sm" className="grid gap-2 md:grid-cols-3">
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <Link
            key={action.label}
            href={action.href}
            className="group flex items-center gap-3 rounded-xl border border-border/50 bg-card/80 px-3 py-2.5 transition-colors hover:border-primary/25 hover:bg-card"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/[0.07] text-primary">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {action.label}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {action.detail}
              </span>
            </span>
          </Link>
        );
      })}
    </Surface>
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
