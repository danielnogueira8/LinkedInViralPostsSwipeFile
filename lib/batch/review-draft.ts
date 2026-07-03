// Shared mapping: a chat_artifacts row → the ReviewDraft shape the batch review
// panel renders. Lives here (not on the Posts page) so BOTH the server component
// (page.tsx, first paint) AND the live-poll endpoint (/api/batch/weekly/
// review-drafts) build byte-identical objects — the panel's add-only reseed
// dedups by id, so any drift between the two sources would show as duplicated or
// mismatched cards. One mapper, no drift.

import type { ReviewDraft } from "@/app/(app)/dashboard/posts/batch-review-panel";
import type { DraftKind } from "@/app/(app)/dashboard/posts/drafts-list";

// The chat_artifacts columns both surfaces select. Keep in sync with the SELECT
// in page.tsx and the review-drafts route.
export const REVIEW_DRAFT_COLS =
  "id, title, body, meta, kind, status, plan_to_post_on, chat_id, created_at, scheduled_at, schedule_status, first_comment, published_at, publish_error";

export type ReviewDraftRow = {
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

// Pull the weekly-batch source URL out of a draft's meta jsonb, when present.
// Only a batch draft has meta.source === 'weekly_batch' with a source_url;
// everything else returns null (no "adapted from" link).
export function sourceUrlFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { source?: unknown; source_url?: unknown };
  if (m.source !== "weekly_batch") return null;
  return typeof m.source_url === "string" && m.source_url ? m.source_url : null;
}

// Map one pending_review row to a ReviewDraft. The review card only edits
// body/title, so we hand it a board-valid status ('drafting') to satisfy the
// Draft type — the real DB status stays 'pending_review' until approve/reject.
export function toReviewDraft(row: ReviewDraftRow): ReviewDraft {
  const kind = (
    row.kind === "hook" || row.kind === "lead_magnet" ? row.kind : "post"
  ) as DraftKind;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind,
    status: "drafting",
    planToPostOn: row.plan_to_post_on,
    chatId: row.chat_id,
    createdAt: row.created_at,
    sourceUrl: sourceUrlFromMeta(row.meta),
    scheduledAt: row.scheduled_at,
    scheduleStatus: row.schedule_status as ReviewDraft["scheduleStatus"],
    firstComment: row.first_comment,
    publishedAt: row.published_at,
    publishError: row.publish_error,
    isLeadMagnet: kind === "lead_magnet",
  };
}
