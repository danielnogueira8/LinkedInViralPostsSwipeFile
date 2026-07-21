// The leadshark_bind_automation background-job handler.
//
// Runs after a lead-magnet post publishes. Resolves the LinkedIn activity URN
// (via the strategy seam), creates the LeadShark automation, and confirms the
// bind stuck. Returns the worker's { completed, failed, requeued, unsupported }
// contract; THROWS to let the worker's retry/backoff handle a transient miss
// (so the ~6-attempt / ~45-min budget in the plan applies).
//
// Payload: { automationId: string }. The workspace is read from the job row.

import {
  type BackgroundJob,
  enqueueBackgroundJob,
  markJobDone,
  markJobFailed,
} from "@/lib/background-jobs";
import { supabaseAdmin } from "@/lib/supabase";
import { getDecryptedKey } from "@/lib/leadshark-credentials";
import {
  getAutomationById,
  getAutomationForArtifact,
  markBindingStarted,
  markBound,
  markBindError,
} from "@/lib/leadshark-automations";

// Roughly +1m,+2m,+4m,+8m,+15m,+15m ≈ 45 min over 6 attempts, using the
// existing background_jobs backoff (capped at 15 min). Then awaiting_urn.
const BIND_MAX_ATTEMPTS = 6;
import {
  createAutomation,
  getAutomation,
  listAutomations,
  assertActivityUrn,
  isActivityUrn,
  type AutomationConfig,
  type BoundPostIdentity,
} from "@/lib/leadshark";
import { resolverFor } from "@/lib/leadshark-binding";

export type JobResult = {
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
};

const DONE: JobResult = { completed: 1, failed: 0, requeued: 0, unsupported: 0 };

// A retryable miss — throw so the worker requeues within the job's attempt
// budget. On the LAST attempt the worker marks the job failed; we separately
// flip the automation to awaiting_urn so the UI offers manual paste.
class BindRetryableError extends Error {}

// Entry point wired into the worker's dispatch. Settles the background_jobs row
// (markJobDone / markJobFailed) based on the outcome, then returns the worker's
// count contract. A thrown BindRetryableError propagates so the worker's
// requeue-with-backoff path runs (staying within the job's max_attempts budget).
export async function runLeadSharkBindJob(job: BackgroundJob): Promise<JobResult> {
  const sb = supabaseAdmin();
  const result = await executeBind(job);
  if (result.completed) await markJobDone(job, { bound: true }, sb);
  else if (result.failed) await markJobFailed(job, "LeadShark binding failed.", sb);
  return result;
}

async function executeBind(job: BackgroundJob): Promise<JobResult> {
  const workspaceId = job.workspace_id;
  const automationId = String((job.payload as { automationId?: unknown })?.automationId ?? "");
  if (!automationId) {
    // Malformed payload — nothing to retry.
    return { completed: 0, failed: 1, requeued: 0, unsupported: 1 };
  }

  const automation = await getAutomationById(workspaceId, automationId);
  if (!automation || automation.status === "deleted") {
    // The user removed it before we bound — nothing to do, not a failure.
    return DONE;
  }
  // Already bound (a duplicate job, or a retry after a successful bind) — idempotent.
  if (automation.status === "active" && automation.leadsharkAutomationId) {
    return DONE;
  }

  const apiKey = await getDecryptedKey(workspaceId);
  if (!apiKey) {
    // Credential was disconnected/invalidated after scheduling. Terminal for
    // this automation; surface it rather than retrying forever.
    await markBindError(workspaceId, automationId, {
      error: "LeadShark isn't connected. Reconnect it, then retry.",
      errorCode: "no_credential",
      status: "failed",
    });
    return { completed: 0, failed: 1, requeued: 0, unsupported: 0 };
  }

  const isLastAttempt = job.attempts >= job.max_attempts;

  try {
    return await bindOnce(workspaceId, automation, apiKey);
  } catch (e) {
    if (e instanceof BindRetryableError) {
      await markBindError(workspaceId, automationId, {
        error: e.message,
        errorCode: "pending",
        incrementAttempts: true,
        // On the last attempt, park it for manual resolution rather than a
        // silent failed state.
        status: isLastAttempt ? "awaiting_urn" : "binding",
      });
      if (isLastAttempt) {
        // Don't throw on the last attempt — we've recorded awaiting_urn, and the
        // job itself is "done" (its work concluded: it exhausted auto-binding).
        return DONE;
      }
      throw e; // let the worker requeue with backoff
    }
    // Unexpected error — record and rethrow so the worker's generic handling
    // applies (it will retry within budget, then fail the job).
    await markBindError(workspaceId, automationId, {
      error: (e as Error)?.message ?? "Binding failed.",
      errorCode: "error",
      incrementAttempts: true,
    });
    throw e;
  }
}

async function bindOnce(
  workspaceId: string,
  automation: NonNullable<Awaited<ReturnType<typeof getAutomationById>>>,
  apiKey: string,
): Promise<JobResult> {
  const resolver = resolverFor();
  const outcome = await resolver.resolve({
    apiKey,
    zernioPostUrl: automation.zernioPostUrl,
    zernioPostUrn: automation.zernioPostUrn,
    urnSnapshot: null, // url_match default doesn't need it; snapshot path reads DB separately
  });

  if (outcome.kind === "error") {
    throw new Error(outcome.error.message);
  }
  if (outcome.kind === "pending") {
    throw new BindRetryableError(outcome.reason);
  }
  if (outcome.kind === "ambiguous") {
    // Never guess — park for manual resolution immediately (not retryable).
    await markBindError(workspaceId, automation.id, {
      error: `Couldn't identify your post automatically (${outcome.reason}).`,
      errorCode: "ambiguous",
      status: "awaiting_urn",
    });
    return DONE;
  }

  // outcome.kind === "resolved". The FINAL guard: never send a non-activity URN.
  if (!isActivityUrn(outcome.postId)) {
    await markBindError(workspaceId, automation.id, {
      error:
        "Resolved a post id that isn't a LinkedIn activity URN — refusing to bind " +
        "(it would silently never fire). Paste the post URL to bind manually.",
      errorCode: "non_activity_urn",
      status: "awaiting_urn",
    });
    return DONE;
  }
  const postId = assertActivityUrn(outcome.postId);

  // §9.4 — if Auto-Automate already created an automation for this post, adopt
  // it rather than creating a second (which would double-DM commenters).
  const existing = await findExistingAutomationForPost(apiKey, postId);
  if (existing) {
    await markBound(workspaceId, automation.id, {
      linkedinPostUrn: postId,
      linkedinPostUrl: outcome.shareUrl,
      leadsharkAutomationId: existing,
    });
    return DONE;
  }

  const identity: BoundPostIdentity = {
    postId,
    linkedinPostUrl: outcome.shareUrl ?? automation.zernioPostUrl ?? "",
  };
  const created = await createAutomation(apiKey, automation.config as AutomationConfig, identity);
  if (!created.ok) {
    // A create-time upstream error. Auth/plan issues are terminal-ish; treat as
    // retryable transient only when the error kind says so.
    if (created.error.kind === "transient" || created.error.kind === "rate_limited") {
      throw new BindRetryableError(created.error.message);
    }
    await markBindError(workspaceId, automation.id, {
      error: created.error.message,
      errorCode: created.error.kind,
      status: "failed",
    });
    return { completed: 0, failed: 1, requeued: 0, unsupported: 0 };
  }

  // Read back to confirm the bind stuck — catches the silent-bind failure where
  // LeadShark accepts the create but stores a post_id that won't match events.
  const readBack = await getAutomation(apiKey, created.automation.id);
  if (readBack.ok && readBack.automation.postId && readBack.automation.postId !== postId) {
    await markBindError(workspaceId, automation.id, {
      error:
        "LeadShark stored a different post id than we sent — the automation may not fire. " +
        "Paste the post URL to rebind.",
      errorCode: "readback_mismatch",
      status: "awaiting_urn",
    });
    return DONE;
  }

  await markBound(workspaceId, automation.id, {
    linkedinPostUrn: postId,
    linkedinPostUrl: outcome.shareUrl,
    leadsharkAutomationId: created.automation.id,
  });
  return DONE;
}

// Look for an existing LeadShark automation already targeting this URN (the
// Auto-Automate dedupe). Best-effort — a failure here shouldn't block binding.
async function findExistingAutomationForPost(
  apiKey: string,
  postId: string,
): Promise<string | null> {
  const listed = await listAutomations(apiKey, { limit: 50 });
  if (!listed.ok) return null;
  const match = listed.automations.find((a) => a.postId === postId);
  return match?.id ?? null;
}

// ---------------------------------------------------------------------------
// Publish hook — called from lib/draft-publishing.ts the instant a lead-magnet
// post publishes. If the draft has a configured automation, capture the Zernio
// post identity and enqueue the binding job immediately. Idempotent and
// isolated: the caller wraps this so a LeadShark failure never breaks publish.
// ---------------------------------------------------------------------------

export async function onPublishedForLeadShark(opts: {
  workspaceId: string;
  artifactId: string;
  platformPostUrl: string | null;
  platformPostId: string | null;
}): Promise<void> {
  const automation = await getAutomationForArtifact(opts.workspaceId, opts.artifactId);
  // No configured automation (the common case for most drafts) → nothing to do.
  if (!automation || automation.status === "deleted") return;
  // Already past the configure stage (a republish / duplicate publish) — don't
  // re-enqueue on top of an in-flight or completed bind.
  if (automation.status !== "configured") return;

  await markBindingStarted(opts.workspaceId, opts.artifactId, {
    zernioPostUrl: opts.platformPostUrl,
    zernioPostUrn: opts.platformPostId,
  });

  await enqueueBackgroundJob({
    workspaceId: opts.workspaceId,
    type: "leadshark_bind_automation",
    payload: { automationId: automation.id },
    maxAttempts: BIND_MAX_ATTEMPTS,
  });
}
