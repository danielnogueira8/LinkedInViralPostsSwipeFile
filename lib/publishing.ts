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
}> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("chat_artifacts")
    .select("id, workspace_id, body, status, first_comment, media_attachments")
    .eq("schedule_status", "scheduled")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(PUBLISH_BATCH);
  const due = (data ?? []) as DueRow[];

  let published = 0;
  let failed = 0;
  for (const row of due) {
    // ---- Atomic claim: flip scheduled → publishing, only if still scheduled.
    const { data: claimed } = await sb
      .from("chat_artifacts")
      .update({ schedule_status: "publishing" })
      .eq("id", row.id)
      .eq("workspace_id", row.workspace_id)
      .eq("schedule_status", "scheduled")
      .select("id")
      .maybeSingle();
    if (!claimed) continue; // another tick got it — skip

    // ---- Resolve the workspace's connection (never client input).
    const conn = await getConnection(row.workspace_id);
    if (!canPublish(conn) || !conn?.zernio_account_id) {
      await failRow(row, "Your LinkedIn connection isn't active. Reconnect it in Settings, then reschedule.");
      failed++;
      continue;
    }

    // ---- Publish.
    const parsedMedia = postMediaAttachmentsSchema.safeParse(row.media_attachments ?? []);
    if (!parsedMedia.success) {
      await failRow(row, "One attached media file is invalid. Remove it and upload again.");
      failed++;
      continue;
    }
    const mediaAttachments = parsedMedia.data as PostMediaAttachment[];
    const mediaError = validatePostMediaSet(mediaAttachments);
    if (mediaError) {
      await failRow(row, mediaError);
      failed++;
      continue;
    }
    const result = await createLinkedInPost({
      accountId: conn.zernio_account_id,
      content: row.body,
      firstComment: row.first_comment,
      mediaItems: mediaAttachments.length ? toZernioMediaItems(mediaAttachments) : undefined,
    });

    if (result.ok) {
      await sb
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
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id);
      await logZernioUsage("linkedin_publish", row.workspace_id, {
        artifact_id: row.id,
        zernio_post_id: result.postId,
      });
      published++;
      console.log(JSON.stringify({ linkedin_publish: { workspace_id: row.workspace_id, artifact_id: row.id } }));
    } else {
      const err = result.error;
      // Token expiry → also flip the connection so Settings shows Reconnect.
      if (err.kind === "token_expired") {
        await markDisconnected(row.workspace_id, "LinkedIn access expired");
      }
      // Duplicate (422) is permanent → fail now. Transient may retry next tick
      // until the attempt cap.
      const attempts = await bumpAttempts(row);
      const retryable = err.kind !== "duplicate" && attempts < MAX_PUBLISH_ATTEMPTS;
      if (retryable) {
        // Back to 'scheduled' so a later tick retries; keep the error visible.
        await sb
          .from("chat_artifacts")
          .update({ schedule_status: "scheduled", publish_error: err.message })
          .eq("id", row.id)
          .eq("workspace_id", row.workspace_id);
      } else {
        await failRow(row, err.message);
        failed++;
      }
      console.log(JSON.stringify({ linkedin_publish_fail: { workspace_id: row.workspace_id, artifact_id: row.id, kind: err.kind, attempts, retryable } }));
    }
  }
  return { due: due.length, published, failed };
}

// Increment publish_attempts and return the new count (read-then-write; the row
// is single-claimed by this tick so there's no concurrent writer).
async function bumpAttempts(row: DueRow): Promise<number> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("chat_artifacts")
    .select("publish_attempts")
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id)
    .maybeSingle();
  const next = ((data?.publish_attempts as number) ?? 0) + 1;
  await sb
    .from("chat_artifacts")
    .update({ publish_attempts: next })
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id);
  return next;
}

// Terminal failure: mark 'failed' with a human message. The board status is
// left where it was (the draft never left the board), so it's not lost.
async function failRow(row: DueRow, message: string): Promise<void> {
  await supabaseAdmin()
    .from("chat_artifacts")
    .update({ schedule_status: "failed", publish_error: message })
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id);
}
