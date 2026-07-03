import { scopedSupabase } from "@/lib/supabase-scoped";
import { DraftsList, type DraftStatus, type Draft } from "./drafts-list";
import { GenerateBatchButton } from "./generate-batch-button";
import { BatchReviewPanel, type ReviewDraft } from "./batch-review-panel";

// Saved posts — the drafts the user kept via "Save draft" in the chat, plus any
// authored on the board (rows in chat_artifacts). Rendered as a Notion-style
// pipeline board: each card is the post's name; clicking it opens a detail
// drawer to edit the body, status, due date, and name.

export const dynamic = "force-dynamic";

type DraftRow = {
  id: string;
  title: string | null;
  body: string;
  meta: unknown;
  kind: string;
  status: string;
  plan_to_post_on: string | null;
  chat_id: string | null;
  created_at: string;
  scheduled_at: string | null;
  schedule_status: string | null;
  first_comment: string | null;
  published_at: string | null;
  publish_error: string | null;
};

export default async function DraftsPage() {
  const sb = await scopedSupabase();

  const { data: drafts } = await sb.raw
    .from("chat_artifacts")
    .select(
      "id, title, body, meta, kind, status, plan_to_post_on, chat_id, created_at, scheduled_at, schedule_status, first_comment, published_at, publish_error",
    )
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
    const base = {
      id: row.id,
      title: row.title,
      body: row.body,
      kind: (row.kind === "hook" || row.kind === "lead_magnet"
        ? row.kind
        : "post") as Draft["kind"],
      planToPostOn: row.plan_to_post_on,
      chatId: row.chat_id,
      createdAt: row.created_at,
      // Surface the batch source link (meta.source_url) for "Adapted from ↗".
      sourceUrl: sourceUrlFromMeta(row.meta),
      scheduledAt: row.scheduled_at,
      scheduleStatus: row.schedule_status as Draft["scheduleStatus"],
      firstComment: row.first_comment,
      publishedAt: row.published_at,
      publishError: row.publish_error,
    };
    if (row.status === "pending_review") {
      review.push({
        ...base,
        // The modal edits body/title only; give it a board-valid status so its
        // type is satisfied (the review draft isn't shown/moved as this stage).
        status: "drafting",
        isLeadMagnet: base.kind === "lead_magnet",
      });
    } else if (isBoardStatus(row.status)) {
      board.push({ ...base, status: row.status });
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

// Pull the weekly-batch source URL out of a draft's meta jsonb, when present.
// Only a batch draft has meta.source === 'weekly_batch' with a source_url;
// everything else returns null (no "adapted from" link). Exported for tests.
export function sourceUrlFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { source?: unknown; source_url?: unknown };
  if (m.source !== "weekly_batch") return null;
  return typeof m.source_url === "string" && m.source_url ? m.source_url : null;
}
