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
    .select("id, workspace_id, body, status, first_comment")
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
    const result = await createLinkedInPost({
      accountId: conn.zernio_account_id,
      content: row.body,
      firstComment: row.first_comment,
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

// ---------------------------------------------------------------------------
// Shared schedule/cancel: the SAME validation + commit logic the schedule
// endpoint uses, exposed for the agent tool so "schedule this post for tomorrow
// noon" in chat and clicking "Schedule" in the editor go through one gate.
// ---------------------------------------------------------------------------

import { LINKEDIN_MAX_CHARS } from "@/lib/zernio";

// The four on-board stages — a schedulable draft must be one of these, never
// the off-board review statuses (approve first; the review gate is sovereign).
const SCHEDULABLE_STATUSES = new Set(["idea", "drafting", "ready", "posted"]);

export type ScheduleError =
  | "not_connected"
  | "past_time"
  | "invalid_time"
  | "needs_timezone" // a wall time was given but no timezone (arg or workspace default)
  | "not_found"
  | "too_long"
  | "not_board_status";

// Read the workspace's saved default timezone from the settings table
// (workspace-scoped since migration 011). Returns null if none is set.
// The scheduler uses this as a FALLBACK when the caller passes a wall time
// without an explicit timezone — so users don't have to say "Europe/Lisbon"
// every time.
export async function getWorkspaceTimezone(
  workspaceId: string,
): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("settings")
      .select("value")
      .eq("workspace_id", workspaceId)
      .eq("key", "default_timezone")
      .maybeSingle();
    const v = data?.value;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && typeof (v as { timezone?: unknown }).timezone === "string") {
      const tz = (v as { timezone: string }).timezone.trim();
      if (tz) return tz;
    }
    return null;
  } catch {
    return null;
  }
}

// True if `s` looks like a local wall time (no Z or ±HH:MM offset). Used to
// detect when we should try the workspace default timezone as a fallback.
function isWallTime(s: string): boolean {
  const t = s.trim();
  if (/Z$|[+-]\d{2}:\d{2}$/.test(t)) return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(t);
}

export type ScheduleResult =
  | {
      ok: true;
      scheduledAt: string; // ISO instant (UTC)
      planToPostOn: string; // YYYY-MM-DD (UTC date)
      firstComment: string | null;
    }
  | { ok: false; error: ScheduleError; message: string };

// Resolve a scheduledAt input to an ISO instant. Accepts either:
//   (a) a full ISO instant (Z or ±HH:MM offset) — used verbatim; OR
//   (b) a local wall time YYYY-MM-DDTHH:MM (no offset) + an IANA timezone.
// Never guesses a timezone — a wall time without one is an error, because
// "tomorrow noon" in Lisbon vs. San Francisco is a 7-hour difference and the
// wrong post could go out overnight. Returns null if unparseable.
export function resolveScheduleAt(
  scheduledAt: string,
  timezone?: string | null,
): string | null {
  const s = scheduledAt.trim();
  // ISO instant with an explicit offset (Z or +HH:MM at the end)? Trust it.
  if (/Z$|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Local wall time YYYY-MM-DDTHH:MM(:SS)? — need a timezone to disambiguate.
  const wallMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!wallMatch) return null;
  if (!timezone || !timezone.trim()) return null;
  const [, y, mo, d, h, mi, se] = wallMatch;
  // Compute the UTC instant that renders as this wall time in the given IANA
  // zone. Use Intl to read back the wall-time components of an initial guess
  // and correct once — a single correction handles every non-anomalous case.
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se ?? 0));
  const tz = timezone.trim();
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return null; // invalid IANA timezone
  }
  const readParts = (utcMs: number): Record<string, number> => {
    const parts = fmt.formatToParts(new Date(utcMs));
    const out: Record<string, number> = {};
    for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
    // Intl may format midnight as "24" — normalize.
    if (out.hour === 24) out.hour = 0;
    return out;
  };
  const target = { year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: +(se ?? 0) };
  const shown = readParts(guess);
  const offsetMs =
    Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second) -
    Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  const utcMs = guess - offsetMs;
  const d2 = new Date(utcMs);
  return Number.isNaN(d2.getTime()) ? null : d2.toISOString();
}

// Schedule a draft for real timed publishing. Same validation gate as the
// route: active connection, future-only, ≤3000 chars, board-status draft.
// Called by BOTH the schedule endpoint and the agent tool.
export async function scheduleDraftPublish(opts: {
  draftId: string;
  workspaceId: string;
  scheduledAt: string;
  timezone?: string | null;
  firstComment?: string | null;
}): Promise<ScheduleResult> {
  const conn = await getConnection(opts.workspaceId);
  if (!canPublish(conn)) {
    return {
      ok: false,
      error: "not_connected",
      message: "Connect your LinkedIn account in Settings to schedule posts.",
    };
  }

  // Resolve the time. If we got a wall time without a timezone, try the
  // workspace default (Settings → Publishing) before giving up. Only if the
  // workspace has no default either do we ask the caller to supply one.
  let iso = resolveScheduleAt(opts.scheduledAt, opts.timezone);
  if (!iso && isWallTime(opts.scheduledAt) && !opts.timezone) {
    const wsTz = await getWorkspaceTimezone(opts.workspaceId);
    if (wsTz) iso = resolveScheduleAt(opts.scheduledAt, wsTz);
    if (!iso) {
      return {
        ok: false,
        error: "needs_timezone",
        message:
          "You gave a time but no timezone. Ask the user which timezone (e.g. Europe/Lisbon) — or set a default in Settings → Publishing.",
      };
    }
  }
  if (!iso) {
    return {
      ok: false,
      error: "invalid_time",
      message:
        "Couldn't read that time. Use an ISO instant like 2026-07-04T16:00:00Z, or a local time YYYY-MM-DDTHH:MM with a timezone (e.g. Europe/Lisbon).",
    };
  }
  // 60s skew grace so "now-ish" doesn't 400 on round-trip.
  if (new Date(iso).getTime() < Date.now() - 60_000) {
    return { ok: false, error: "past_time", message: "Pick a time in the future." };
  }

  const sb = supabaseAdmin();
  const { data: draft } = await sb
    .from("chat_artifacts")
    .select("id, body, status")
    .eq("id", opts.draftId)
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (!draft) {
    return { ok: false, error: "not_found", message: "Draft not found." };
  }
  const len = ((draft.body as string) ?? "").length;
  if (len > LINKEDIN_MAX_CHARS) {
    return {
      ok: false,
      error: "too_long",
      message: `This post is ${len} characters — LinkedIn's limit is ${LINKEDIN_MAX_CHARS}. Trim ${len - LINKEDIN_MAX_CHARS} characters, then schedule.`,
    };
  }
  if (!SCHEDULABLE_STATUSES.has((draft.status as string) ?? "")) {
    return {
      ok: false,
      error: "not_board_status",
      message: "Approve this draft onto your board before scheduling it.",
    };
  }

  const localDate = iso.slice(0, 10);
  const fc = opts.firstComment?.trim() || null;
  const { error } = await sb
    .from("chat_artifacts")
    .update({
      schedule_status: "scheduled",
      scheduled_at: iso,
      first_comment: fc,
      plan_to_post_on: localDate,
      publish_error: null,
      publish_attempts: 0,
      zernio_post_id: null,
      published_at: null,
    })
    .eq("id", opts.draftId)
    .eq("workspace_id", opts.workspaceId);
  if (error) {
    return { ok: false, error: "not_found", message: error.message };
  }
  return { ok: true, scheduledAt: iso, planToPostOn: localDate, firstComment: fc };
}

// Cancel a scheduled publish. Only valid while still 'scheduled' — once the
// cron claims it ('publishing') or it's 'published', there's nothing to cancel.
export async function cancelDraftPublish(opts: {
  draftId: string;
  workspaceId: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data } = await supabaseAdmin()
    .from("chat_artifacts")
    .update({ schedule_status: null, scheduled_at: null, first_comment: null })
    .eq("id", opts.draftId)
    .eq("workspace_id", opts.workspaceId)
    .eq("schedule_status", "scheduled")
    .select("id")
    .maybeSingle();
  if (!data) {
    return { ok: false, message: "This post can't be unscheduled anymore." };
  }
  return { ok: true };
}
