import type { PostMediaAttachment } from "@/lib/post-media";

export const SCHEDULABLE_DRAFT_STATUSES = ["idea", "drafting", "ready"] as const;

export const SCHEDULABLE_SCHEDULE_STATUS_FILTER =
  "schedule_status.is.null,schedule_status.in.(scheduled,failed)";

// Narrower than SCHEDULABLE_SCHEDULE_STATUS_FILTER: a general field mutation
// (status/body/title/etc, NOT the schedule fields themselves) must NOT be
// allowed while a draft is 'scheduled' — otherwise the Status dropdown could
// flip a queued draft to 'posted' while schedule_status/scheduled_at stay
// untouched, desyncing the board label from what the publish cron will
// actually do. schedule()/cancelSchedule() legitimately touch a 'scheduled'
// row (that's their whole job); a generic mutate() write does not. The app
// layer (DraftLifecycle.mutate) already rejects this before reaching the
// repository — this is the SQL-level backstop so the guarantee holds even if
// a future caller bypasses that layer.
export const MUTATABLE_SCHEDULE_STATUS_FILTER =
  "schedule_status.is.null,schedule_status.eq.failed";

export const DRAFT_SCHEDULING_CONFLICT =
  "This draft is already publishing or published and can't be rescheduled.";

export const DRAFT_MUTATION_CONFLICT =
  "This draft is already publishing or published and can't be changed.";

export const ZERNIO_TEMP_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Only direct Zernio uploads expire (Zernio hosts them for 7 days). Library
// attachments are re-uploaded at publish time, so their age is irrelevant —
// filtering here (not at the call site) is what keeps the MCP and HTTP
// schedule paths from drifting. Returns null when nothing expires.
export function earliestZernioMediaExpiry(
  attachments: PostMediaAttachment[],
): number | null {
  const uploaded = attachments
    .filter((a) => (a.source ?? "zernio") === "zernio")
    .map((a) => new Date(a.uploadedAt).getTime())
    .filter((t) => Number.isFinite(t));
  if (uploaded.length === 0) return null;
  return Math.min(...uploaded) + ZERNIO_TEMP_MEDIA_TTL_MS;
}
