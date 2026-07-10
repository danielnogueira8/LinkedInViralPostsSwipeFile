// Publishing connections — the workspace ↔ Zernio-LinkedIn link that the
// scheduler publishes through. Workspace-scoped reads/writes on
// publishing_connections (migration 057). Shared by the Settings integration
// routes, the schedule endpoint, and the publisher cron.
//
// The zernio_account_id is resolved from the CALLER's workspace_id here — never
// from client input (a client-supplied account id would be a
// post-to-someone-else's-LinkedIn IDOR).

import { supabaseAdmin } from "@/lib/supabase";
import {
  createProfile,
  listAccounts,
  createLinkedInPost,
  logZernioUsage,
} from "@/lib/zernio";
import {
  postMediaAttachmentsSchema,
  toZernioMediaItems,
  validatePostMediaSet,
  type PostMediaAttachment,
} from "@/lib/post-media";
import { ensureZernioMediaAttachments } from "@/lib/media-library";

export type PublishingConnection = {
  id: string;
  workspace_id: string;
  network: string;
  zernio_profile_id: string | null;
  zernio_account_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  account_type: "personal" | "organization";
  status: "active" | "disconnected";
  disconnected_reason: string | null;
};

const COLS =
  "id, workspace_id, network, zernio_profile_id, zernio_account_id, display_name, avatar_url, account_type, status, disconnected_reason";

function throwOnDbError(error: unknown): void {
  if (!error) return;
  if (error instanceof Error) throw error;
  const message =
    typeof error === "object" && error && "message" in error
      ? String(error.message)
      : "Database operation failed";
  throw new Error(message, { cause: error });
}

// The workspace's LinkedIn connection row, or null if it has never connected.
// Always workspace-scoped.
export async function getConnection(
  workspaceId: string,
): Promise<PublishingConnection | null> {
  const { data } = await supabaseAdmin()
    .from("publishing_connections")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("network", "linkedin")
    .maybeSingle();
  return (data as PublishingConnection) ?? null;
}

// True when the workspace can publish right now (connected + not disconnected +
// has a resolved account id). The schedule endpoint + cron gate on this.
export function canPublish(conn: PublishingConnection | null): boolean {
  return !!conn && conn.status === "active" && !!conn.zernio_account_id;
}

// Ensure the workspace has a Zernio PROFILE (a per-workspace container) and a
// publishing_connections row carrying its id, WITHOUT an account yet. Called at
// connect-start: creates the profile on first ever connect and reuses it after.
// Returns the profile id to hand to the connect-URL call.
export async function ensureProfile(workspaceId: string): Promise<string> {
  const existing = await getConnection(workspaceId);
  if (existing?.zernio_profile_id) return existing.zernio_profile_id;

  // First connect for this workspace → create a Zernio profile for it.
  const profileId = await createProfile(`swipein-${workspaceId}`);

  // Upsert the row (unique on workspace_id+network) in a PENDING state: profile
  // set, no account yet, status disconnected until the callback finalizes.
  await supabaseAdmin()
    .from("publishing_connections")
    .upsert(
      {
        workspace_id: workspaceId,
        network: "linkedin",
        zernio_profile_id: profileId,
        status: "disconnected",
        disconnected_reason: "Connection not finished",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,network" },
    );
  return profileId;
}

// Finalize after the user returns from Zernio's hosted OAuth: find the workspace
// profile's newly-connected LinkedIn account (the callback doesn't carry the id,
// so we reconcile via GET /v1/accounts scoped to the profile) and write it onto
// the connection row as active. Returns true if an account was found + linked.
export async function finalizeConnection(workspaceId: string): Promise<boolean> {
  const conn = await getConnection(workspaceId);
  if (!conn?.zernio_profile_id) return false;

  const accounts = await listAccounts(conn.zernio_profile_id);
  const linkedin = accounts.find((a) => a.platform === "linkedin" && a.isActive);
  if (!linkedin) return false;

  await supabaseAdmin()
    .from("publishing_connections")
    .update({
      zernio_account_id: linkedin.id,
      display_name: linkedin.displayName,
      status: "active",
      disconnected_reason: null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("network", "linkedin");
  return true;
}

// Mark the workspace's connection disconnected (user action OR a token-expiry
// error from the publisher). Workspace-scoped. Optionally records a reason.
export async function markDisconnected(
  workspaceId: string,
  reason: string | null = null,
): Promise<void> {
  await supabaseAdmin()
    .from("publishing_connections")
    .update({
      status: "disconnected",
      disconnected_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("network", "linkedin");
}

// ---------------------------------------------------------------------------
// The publisher — run by the /api/cron/publish-scheduled cron every 5 min.
// Scans due schedules, publishes each via Zernio, flips the board status to
// 'posted'. Our DB is the single source of truth: nothing is scheduled on
// Zernio's side, so cancel/reschedule/edit-after-schedule are plain DB updates
// until the moment this claims + publishes a row.
// ---------------------------------------------------------------------------

// A due row is 'scheduled' with scheduled_at in the past. Small per-tick cap so
// one tick can't run long; the next tick picks up the rest.
const PUBLISH_BATCH = 10;
// Transient failures may retry on later ticks up to this many attempts, then
// stay 'failed'. A duplicate (422) is permanent and never retried.
const MAX_PUBLISH_ATTEMPTS = 3;

// A row claimed into 'publishing' (the atomic scheduled→publishing flip below)
// but never reaching a terminal state (published/failed/back-to-scheduled) is
// an ORPHAN: the due-query only ever selects 'scheduled' rows, so nothing picks
// it up again, and the unschedule route explicitly refuses anything that isn't
// 'scheduled' — so the user can't even cancel it. The card just sits in the
// Scheduled column forever, looking fine, never publishing.
//
// This happens on a narrow but real window: the serverless function is killed
// (timeout/crash) between the claim and the terminal write, or getConnection()
// throws before the try block that would otherwise route to failRow().
//
// Sweep stale 'publishing' rows to 'failed' (NOT back to 'scheduled') before
// each tick's due-query runs. Failed — not re-queued — because we can't tell
// whether the LinkedIn post actually went out before the crash; silently
// retrying risks a double-post. The user sees a clear, actionable error and
// consciously reschedules; Zernio's duplicate detection (422 → permanent fail)
// backstops a genuine double-attempt if the underlying post did succeed.
//
// chat_artifacts has no updated_at column (added on migration 057, which
// didn't need one), so we can't ask "when was this claimed". Instead we use
// scheduled_at as the staleness clock: a row only ever enters 'publishing' at
// or after its scheduled_at (the claim happens inside the same due-query pass
// that requires scheduled_at <= now), so "still publishing AND scheduled_at is
// more than the threshold in the past" is a safe signal that the claiming tick
// died — a healthy publish completes in seconds, not minutes. No migration
// needed.
const STALE_PUBLISHING_MINUTES = 10;

// Pure: the ISO cutoff for "stale" — scheduled_at at or before this means a
// 'publishing' row has been claimed for at least STALE_PUBLISHING_MINUTES.
// Exported for tests.
export function stalePublishingCutoffIso(
  nowIso: string,
  staleMinutes: number = STALE_PUBLISHING_MINUTES,
): string {
  return new Date(new Date(nowIso).getTime() - staleMinutes * 60_000).toISOString();
}

// Flip orphaned 'publishing' rows to 'failed' with a clear, actionable message.
// Workspace-scoped isn't meaningful here (this runs across all workspaces, like
// the due-query itself) — supabaseAdmin with no workspace filter is correct for
// a cron sweep, same pattern as publishDueDrafts' own due-query below.
async function sweepStalePublishing(nowIso: string): Promise<number> {
  const sb = supabaseAdmin();
  const cutoff = stalePublishingCutoffIso(nowIso);
  const { data, error } = await sb
    .from("chat_artifacts")
    .update({
      schedule_status: "failed",
      publish_error:
        "Publishing was interrupted before it could finish. Please reschedule.",
    })
    .eq("schedule_status", "publishing")
    .lte("scheduled_at", cutoff)
    .select("id");
  throwOnDbError(error);
  return data?.length ?? 0;
}

type DueRow = {
  id: string;
  workspace_id: string;
  body: string;
  status: string;
  first_comment: string | null;
  media_attachments?: unknown;
};

// Publish every due draft. Returns a small summary for the cron's log. Each row
// is CLAIMED atomically before any Zernio call (UPDATE ... WHERE
// schedule_status='scheduled' — proceed only if a row changed), so two
// overlapping ticks can never double-post the same draft.
export async function publishDueDrafts(nowIso: string): Promise<{
  due: number;
  published: number;
  failed: number;
  staleSwept: number;
}> {
  // Recover any row orphaned by a prior tick's crash BEFORE this tick's own
  // due-query — otherwise a stuck row just sits there forever (see
  // sweepStalePublishing's comment for why this exists).
  const staleSwept = await sweepStalePublishing(nowIso);
  if (staleSwept > 0) {
    console.log(JSON.stringify({ linkedin_publish_stale_swept: { count: staleSwept } }));
  }

  const sb = supabaseAdmin();
  const { data, error: dueError } = await sb
    .from("chat_artifacts")
    .select("id, workspace_id, body, status, first_comment, media_attachments")
    .eq("schedule_status", "scheduled")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(PUBLISH_BATCH);
  throwOnDbError(dueError);
  const due = (data ?? []) as DueRow[];

  let published = 0;
  let failed = 0;
  for (const row of due) {
    // ---- Atomic claim: flip scheduled → publishing, only if still scheduled.
    const { data: claimed, error: claimError } = await sb
      .from("chat_artifacts")
      .update({ schedule_status: "publishing" })
      .eq("id", row.id)
      .eq("workspace_id", row.workspace_id)
      .eq("schedule_status", "scheduled")
      // Re-check due-ness at claim time. The user may have rescheduled the row
      // after the initial scan but before this update reached Postgres.
      .lte("scheduled_at", nowIso)
      // Return the current publish payload atomically with the claim so an edit
      // made after the initial scan is not lost to the stale scan snapshot.
      .select("id, workspace_id, body, status, first_comment, media_attachments")
      .maybeSingle();
    throwOnDbError(claimError);
    if (!claimed) continue; // another tick got it — skip
    const currentRow = claimed as DueRow;

    // ---- Resolve the workspace's connection (never client input).
    const conn = await getConnection(currentRow.workspace_id);
    if (!canPublish(conn) || !conn?.zernio_account_id) {
      await failRow(currentRow, "Your LinkedIn connection isn't active. Reconnect it in Settings, then reschedule.");
      failed++;
      continue;
    }

    // ---- Publish.
    const parsedMedia = postMediaAttachmentsSchema.safeParse(currentRow.media_attachments ?? []);
    if (!parsedMedia.success) {
      await failRow(currentRow, "One attached media file is invalid. Remove it and upload again.");
      failed++;
      continue;
    }
    let mediaAttachments = parsedMedia.data as PostMediaAttachment[];
    const mediaError = validatePostMediaSet(mediaAttachments);
    if (mediaError) {
      await failRow(currentRow, mediaError);
      failed++;
      continue;
    }
    try {
      mediaAttachments = await ensureZernioMediaAttachments({
        sb,
        workspaceId: currentRow.workspace_id,
        attachments: mediaAttachments,
      });
    } catch (e) {
      await failRow(currentRow, (e as Error).message || "Could not prepare media for publishing.");
      failed++;
      continue;
    }
    if (mediaAttachments.length) {
      const { error: mediaPersistError } = await sb
        .from("chat_artifacts")
        .update({ media_attachments: mediaAttachments })
        .eq("id", currentRow.id)
        .eq("workspace_id", currentRow.workspace_id);
      throwOnDbError(mediaPersistError);
    }
    const result = await createLinkedInPost({
      accountId: conn.zernio_account_id,
      content: currentRow.body,
      firstComment: currentRow.first_comment,
      mediaItems: mediaAttachments.length ? toZernioMediaItems(mediaAttachments) : undefined,
    });

    if (result.ok) {
      const { data: publishedRow, error: publishPersistError } = await sb
        .from("chat_artifacts")
        .update({
          schedule_status: "published",
          published_at: new Date().toISOString(),
          zernio_post_id: result.postId,
          publish_error: null,
          // Move the card to Posted (board→board; direct admin write, keyed by
          // id + workspace — the client PATCH transition guard doesn't apply).
          status: "posted",
        })
        .eq("id", currentRow.id)
        .eq("workspace_id", currentRow.workspace_id)
        .select("id")
        .maybeSingle();
      throwOnDbError(publishPersistError);
      if (!publishedRow) {
        throw new Error("Published post state could not be persisted.");
      }
      await logZernioUsage("linkedin_publish", currentRow.workspace_id, {
        artifact_id: currentRow.id,
        zernio_post_id: result.postId,
      });
      published++;
      console.log(JSON.stringify({ linkedin_publish: { workspace_id: currentRow.workspace_id, artifact_id: currentRow.id } }));
    } else {
      const err = result.error;
      // Token expiry → also flip the connection so Settings shows Reconnect.
      if (err.kind === "token_expired") {
        await markDisconnected(currentRow.workspace_id, "LinkedIn access expired");
      }
      // Duplicate (422) is permanent → fail now. Transient may retry next tick
      // until the attempt cap.
      const attempts = await bumpAttempts(currentRow);
      const retryable = err.kind !== "duplicate" && attempts < MAX_PUBLISH_ATTEMPTS;
      if (retryable) {
        // Back to 'scheduled' so a later tick retries; keep the error visible.
        const { error: retryPersistError } = await sb
          .from("chat_artifacts")
          .update({ schedule_status: "scheduled", publish_error: err.message })
          .eq("id", currentRow.id)
          .eq("workspace_id", currentRow.workspace_id);
        throwOnDbError(retryPersistError);
      } else {
        await failRow(currentRow, err.message);
        failed++;
      }
      console.log(JSON.stringify({ linkedin_publish_fail: { workspace_id: currentRow.workspace_id, artifact_id: currentRow.id, kind: err.kind, attempts, retryable } }));
    }
  }
  return { due: due.length, published, failed, staleSwept };
}

// Increment publish_attempts and return the new count (read-then-write; the row
// is single-claimed by this tick so there's no concurrent writer).
async function bumpAttempts(row: DueRow): Promise<number> {
  const sb = supabaseAdmin();
  const { data, error: readError } = await sb
    .from("chat_artifacts")
    .select("publish_attempts")
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id)
    .maybeSingle();
  throwOnDbError(readError);
  const next = ((data?.publish_attempts as number) ?? 0) + 1;
  const { error: writeError } = await sb
    .from("chat_artifacts")
    .update({ publish_attempts: next })
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id);
  throwOnDbError(writeError);
  return next;
}

// Terminal failure: mark 'failed' with a human message. The board status is
// left where it was (the draft never left the board), so it's not lost.
async function failRow(row: DueRow, message: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("chat_artifacts")
    .update({ schedule_status: "failed", publish_error: message })
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id);
  throwOnDbError(error);
}
