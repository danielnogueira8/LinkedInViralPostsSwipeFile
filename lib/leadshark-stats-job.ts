// The leadshark_sync_stats background-job handler (build plan §7).
//
// Poll-only. One LeadShark call per workspace — GET /api/automations returns the
// `stats` block for every automation in the page, so we fan IN (one call) rather
// than per-automation (which would burn the rate budget). Maps each automation's
// stats onto our active rows by leadshark_automation_id. Stats are COUNTS ONLY —
// no commenter PII is ever stored.
//
// The job row is the only Workspace authority. A legacy payload Workspace may
// be present, but it can never redirect this service-role operation.

import {
  type BackgroundJob,
  acquireProviderLock,
  markJobDone,
  markJobFailed,
} from "@/lib/background-jobs";
import { supabaseAdmin } from "@/lib/supabase";
import { getDecryptedKey } from "@/lib/leadshark-credentials";
import { listAutomations } from "@/lib/leadshark";
import { ingestLeadSharkStatsOutcome } from "@/lib/content-learning/leadshark-outcomes";

type JobResult = {
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
};

export async function runLeadSharkStatsSyncJob(job: BackgroundJob): Promise<JobResult> {
  const sb = supabaseAdmin();
  const workspaceId = job.workspace_id;
  const payloadWorkspaceId = String(
    (job.payload as { workspaceId?: unknown })?.workspaceId ?? "",
  ).trim();
  if (payloadWorkspaceId && payloadWorkspaceId !== workspaceId) {
    await markJobFailed(job, "LeadShark stats Workspace mismatch", sb);
    return { completed: 0, failed: 1, requeued: 0, unsupported: 0 };
  }
  const locked = await acquireProviderLock({
    provider: `leadshark:${workspaceId}`,
    workType: "stats",
    jobId: job.id,
    workspaceId,
    limit: 1,
    sb,
  });
  if (!locked) {
    await markJobDone(job, { skipped: "stats_sync_in_progress" }, sb);
    return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
  }

  const apiKey = await getDecryptedKey(workspaceId);
  if (!apiKey) {
    // No active credential — nothing to sync, not a failure.
    await markJobDone(job, { skipped: "no_credential" }, sb);
    return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
  }

  // Which of our automations are active and bound? Only those need stats.
  const { data, error } = await sb
    .from("leadshark_automations")
    .select("id, leadshark_automation_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .not("leadshark_automation_id", "is", null);
  if (error) {
    await markJobFailed(job, error.message, sb);
    return { completed: 0, failed: 1, requeued: 0, unsupported: 0 };
  }
  const rows = (data ?? []) as Array<{
    id: string;
    leadshark_automation_id: string;
  }>;
  if (rows.length === 0) {
    await markJobDone(job, { synced: 0 }, sb);
    return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
  }

  const byLeadSharkId = new Map(
    rows.map((row) => [row.leadshark_automation_id, row]),
  );

  // One page is enough for the expected per-workspace volume; paginate if a
  // workspace ever exceeds the page size.
  const listed = await listAutomations(apiKey, { page: 1, limit: 50 });
  if (!listed.ok) {
    // A transient upstream failure — throw so the worker requeues within budget.
    throw new Error(`LeadShark stats fetch failed: ${listed.error.message}`);
  }

  const observedAt = new Date().toISOString();
  let synced = 0;
  for (const a of listed.automations) {
    const local = byLeadSharkId.get(a.id);
    if (!local) continue;
    await ingestLeadSharkStatsOutcome({
      db: sb,
      workspaceId,
      automationId: local.id,
      leadSharkAutomationId: a.id,
      stats: a.stats,
      observedAt,
    });
    synced += 1;
  }

  await markJobDone(job, { synced }, sb);
  return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
}
