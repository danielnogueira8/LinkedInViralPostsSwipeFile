// Shared chat_artifacts row shape + source-URL extractor. Both the /posts
// server component (page.tsx, first paint) and any downstream consumer use
// these so column selects stay in lockstep.
//
// The row→ReviewDraft mapper used to live here too, back when batch review
// had its own dedicated panel on /posts. Batch review moved into Cowork's
// batch chat where each draft card carries its own Approve/Reject/Edit
// buttons, so the mapper's gone — the chat renders artifacts via the normal
// chat_messages.artifacts jsonb path.

// The chat_artifacts columns page.tsx selects. Keep in sync with the SELECT.
export const REVIEW_DRAFT_COLS =
  "id, title, body, meta, kind, status, plan_to_post_on, chat_id, created_at, scheduled_at, schedule_status, first_comment, published_at, publish_error, media_attachments";

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
  media_attachments?: unknown;
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
