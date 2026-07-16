import { leadMagnetContextFromMeta, type DraftLeadMagnetContext } from "@/lib/draft-lead-magnet";
import { sourceUrlFromMeta } from "@/lib/batch/review-draft";
import type { PostMediaAttachment } from "@/lib/post-media";

export type DraftStatus = "idea" | "drafting" | "ready" | "posted";
export type DraftKind = "post" | "hook" | "lead_magnet";
export type ScheduleStatus =
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | null;

export type Draft = {
  id: string;
  title: string | null;
  body: string;
  kind: DraftKind;
  status: DraftStatus;
  planToPostOn: string | null;
  chatId: string | null;
  createdAt: string;
  sourceUrl?: string | null;
  scheduledAt?: string | null;
  scheduleStatus?: ScheduleStatus;
  firstComment?: string | null;
  publishedAt?: string | null;
  publishError?: string | null;
  mediaAttachments?: PostMediaAttachment[];
  leadMagnet?: DraftLeadMagnetContext | null;
  meta?: Record<string, unknown> | null;
};

export type DraftViewRow = {
  id: string;
  title: string | null;
  body: string;
  kind: string;
  status: string;
  plan_to_post_on: string | null;
  chat_id: string | null;
  created_at: string;
  meta?: unknown;
  media_attachments?: unknown;
  scheduled_at?: string | null;
  schedule_status?: string | null;
  first_comment?: string | null;
  published_at?: string | null;
  publish_error?: string | null;
};

/** Convert either a board query row or a drafts API row into one client shape. */
export function normalizeDraft(row: DraftViewRow): Draft {
  const status: DraftStatus =
    row.status === "idea" ||
    row.status === "drafting" ||
    row.status === "ready" ||
    row.status === "posted"
      ? row.status
      : "idea";
  const meta =
    row.meta && typeof row.meta === "object"
      ? (row.meta as Record<string, unknown>)
      : null;
  const sourceUrl = sourceUrlFromMeta(meta);
  const draft: Draft = {
    id: row.id,
    title: row.title,
    body: row.body,
    kind:
      row.kind === "hook" || row.kind === "lead_magnet" ? row.kind : "post",
    status,
    planToPostOn: row.plan_to_post_on,
    chatId: row.chat_id,
    createdAt: row.created_at,
    ...(sourceUrl ? { sourceUrl } : {}),
    leadMagnet: leadMagnetContextFromMeta(meta),
    meta,
    mediaAttachments: Array.isArray(row.media_attachments)
      ? (row.media_attachments as PostMediaAttachment[])
      : [],
  };
  if ("scheduled_at" in row) draft.scheduledAt = row.scheduled_at ?? null;
  if ("schedule_status" in row) {
    draft.scheduleStatus =
      row.schedule_status === "scheduled" ||
      row.schedule_status === "publishing" ||
      row.schedule_status === "published" ||
      row.schedule_status === "failed"
        ? row.schedule_status
        : null;
  }
  if ("first_comment" in row) draft.firstComment = row.first_comment ?? null;
  if ("published_at" in row) draft.publishedAt = row.published_at ?? null;
  if ("publish_error" in row) draft.publishError = row.publish_error ?? null;
  return draft;
}
