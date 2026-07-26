// LeadShark automations data-access — the leadshark_automations table
// (migration 121). Workspace-scoped reads/writes, mirroring
// lib/draft-publishing.ts: explicit workspaceId param (works in request AND
// cron/job contexts), supabaseAdmin() with an explicit .eq("workspace_id", …)
// on every query, throwOnDbError.
//
// The "config" half of a row maps to lib/leadshark.ts's AutomationConfig; the
// "binding" half (URNs, leadshark_automation_id, status, stats) is filled in by
// the binding + stats jobs.

import { supabaseAdmin } from "@/lib/supabase";
import type { AutomationConfig } from "@/lib/leadshark";

export type AutomationStatus =
  | "configured"
  | "binding"
  | "awaiting_urn"
  | "active"
  | "paused"
  | "failed"
  | "deleted";

// The full row as the UI/API sees it. dm/keywords/etc. plus binding state.
export type LeadSharkAutomation = {
  id: string;
  artifactId: string;
  leadMagnetId: string | null;
  config: AutomationConfig;
  status: AutomationStatus;
  zernioPostUrl: string | null;
  zernioPostUrn: string | null;
  linkedinPostUrn: string | null;
  linkedinPostUrl: string | null;
  leadsharkAutomationId: string | null;
  bindAttempts: number;
  lastError: string | null;
  lastErrorCode: string | null;
  stats: Record<string, number>;
  statsSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const COLS =
  "id, artifact_id, lead_magnet_id, keywords, dm_template, dm_template_variations, " +
  "comment_reply_templates, non_connection_reply_templates, auto_connect, auto_like, " +
  "follow_up_enabled, follow_up_template, follow_up_delay_minutes, follow_up_only_if_no_response, " +
  "status, zernio_post_url, zernio_post_urn, linkedin_post_urn, linkedin_post_url, " +
  "leadshark_automation_id, bind_attempts, last_error, last_error_code, stats, stats_synced_at, " +
  "created_at, updated_at";

function throwOnDbError(error: unknown): void {
  if (!error) return;
  if (error instanceof Error) throw error;
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : "Database operation failed";
  throw new Error(message, { cause: error });
}

type Row = Record<string, unknown>;

function numberStats(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number") out[k] = v;
    }
  }
  return out;
}

function rowToAutomation(row: Row): LeadSharkAutomation {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    leadMagnetId: (row.lead_magnet_id as string) ?? null,
    config: {
      name: `SwipeIn · ${String(row.artifact_id).slice(0, 8)}`,
      keywords: (row.keywords as string[]) ?? [],
      dmTemplate: (row.dm_template as string) ?? "",
      dmTemplateVariations: (row.dm_template_variations as string[]) ?? [],
      commentReplyTemplates: (row.comment_reply_templates as string[]) ?? [],
      nonConnectionReplyTemplates: (row.non_connection_reply_templates as string[]) ?? [],
      autoConnect: Boolean(row.auto_connect),
      autoLike: Boolean(row.auto_like),
      followUpEnabled: Boolean(row.follow_up_enabled),
      followUpTemplate: (row.follow_up_template as string) ?? null,
      followUpDelayMinutes: Number(row.follow_up_delay_minutes ?? 60),
      followUpOnlyIfNoResponse: Boolean(row.follow_up_only_if_no_response),
    },
    status: row.status as AutomationStatus,
    zernioPostUrl: (row.zernio_post_url as string) ?? null,
    zernioPostUrn: (row.zernio_post_urn as string) ?? null,
    linkedinPostUrn: (row.linkedin_post_urn as string) ?? null,
    linkedinPostUrl: (row.linkedin_post_url as string) ?? null,
    leadsharkAutomationId: (row.leadshark_automation_id as string) ?? null,
    bindAttempts: Number(row.bind_attempts ?? 0),
    lastError: (row.last_error as string) ?? null,
    lastErrorCode: (row.last_error_code as string) ?? null,
    stats: numberStats(row.stats),
    statsSyncedAt: (row.stats_synced_at as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The automation for a given draft artifact, or null. Workspace-scoped. */
export async function getAutomationForArtifact(
  workspaceId: string,
  artifactId: string,
): Promise<LeadSharkAutomation | null> {
  const { data, error } = await supabaseAdmin()
    .from("leadshark_automations")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("artifact_id", artifactId)
    .neq("status", "deleted")
    .maybeSingle();
  throwOnDbError(error);
  return data ? rowToAutomation(data as unknown as Row) : null;
}

/** Load a single automation by id, workspace-scoped. */
export async function getAutomationById(
  workspaceId: string,
  id: string,
): Promise<LeadSharkAutomation | null> {
  const { data, error } = await supabaseAdmin()
    .from("leadshark_automations")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  throwOnDbError(error);
  return data ? rowToAutomation(data as unknown as Row) : null;
}

// ---------------------------------------------------------------------------
// Config write (upsert from the editor panel)
// ---------------------------------------------------------------------------

export type AutomationConfigInput = {
  artifactId: string;
  leadMagnetId: string | null;
  keywords: string[];
  dmTemplate: string;
  dmTemplateVariations: string[];
  commentReplyTemplates: string[];
  nonConnectionReplyTemplates: string[];
  autoConnect: boolean;
  autoLike: boolean;
  followUpEnabled: boolean;
  followUpTemplate: string | null;
  followUpDelayMinutes: number;
  followUpOnlyIfNoResponse: boolean;
};

/**
 * Create or update the automation config for a draft. Upserts on
 * (workspace_id, artifact_id). Only touches config columns — never resets the
 * binding state (status/URNs/leadshark id), so editing config before publish
 * keeps status 'configured', and editing a bound row (a future capability)
 * won't clobber the live binding.
 */
export async function upsertAutomationConfig(
  workspaceId: string,
  input: AutomationConfigInput,
): Promise<LeadSharkAutomation> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from("leadshark_automations")
    .upsert(
      {
        workspace_id: workspaceId,
        artifact_id: input.artifactId,
        lead_magnet_id: input.leadMagnetId,
        keywords: input.keywords,
        dm_template: input.dmTemplate,
        dm_template_variations: input.dmTemplateVariations,
        comment_reply_templates: input.commentReplyTemplates,
        non_connection_reply_templates: input.nonConnectionReplyTemplates,
        auto_connect: input.autoConnect,
        auto_like: input.autoLike,
        follow_up_enabled: input.followUpEnabled,
        follow_up_template: input.followUpTemplate,
        follow_up_delay_minutes: input.followUpDelayMinutes,
        follow_up_only_if_no_response: input.followUpOnlyIfNoResponse,
        updated_at: now,
      },
      { onConflict: "workspace_id,artifact_id" },
    )
    .select(COLS)
    .single();
  throwOnDbError(error);
  return rowToAutomation(data as unknown as Row);
}

/** Remove the automation config for a draft (soft-delete → status 'deleted'). */
export async function deleteAutomationForArtifact(
  workspaceId: string,
  artifactId: string,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("leadshark_automations")
    .update({ status: "deleted", updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("artifact_id", artifactId);
  throwOnDbError(error);
}

// ---------------------------------------------------------------------------
// Binding-lifecycle writes (used by the pre-publish hook + the binding job).
// These take an explicit workspaceId so the cron/job path (no session) is safe.
// ---------------------------------------------------------------------------

/** Persist what Zernio gave us at publish time + move to 'binding'. */
export async function markBindingStarted(
  workspaceId: string,
  artifactId: string,
  fields: { zernioPostUrl: string | null; zernioPostUrn: string | null; urnSnapshot?: string[] },
): Promise<void> {
  const patch: Row = {
    status: "binding",
    zernio_post_url: fields.zernioPostUrl,
    zernio_post_urn: fields.zernioPostUrn,
    updated_at: new Date().toISOString(),
  };
  if (fields.urnSnapshot) patch.urn_snapshot = fields.urnSnapshot;
  const { error } = await supabaseAdmin()
    .from("leadshark_automations")
    .update(patch)
    .eq("workspace_id", workspaceId)
    .eq("artifact_id", artifactId);
  throwOnDbError(error);
}

/** A successful bind: store the resolved URN + LeadShark id, go 'active'. */
export async function markBound(
  workspaceId: string,
  id: string,
  fields: {
    linkedinPostUrn: string;
    linkedinPostUrl: string | null;
    leadsharkAutomationId: string;
  },
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("leadshark_automations")
    .update({
      status: "active",
      linkedin_post_urn: fields.linkedinPostUrn,
      linkedin_post_url: fields.linkedinPostUrl,
      leadshark_automation_id: fields.leadsharkAutomationId,
      last_error: null,
      last_error_code: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", id);
  throwOnDbError(error);
}

/** Record a bind attempt failure. `terminal` flips status to awaiting_urn/failed. */
export async function markBindError(
  workspaceId: string,
  id: string,
  fields: {
    error: string;
    errorCode?: string | null;
    incrementAttempts?: boolean;
    status?: Extract<AutomationStatus, "awaiting_urn" | "failed" | "binding">;
  },
): Promise<void> {
  const patch: Row = {
    last_error: fields.error,
    last_error_code: fields.errorCode ?? null,
    updated_at: new Date().toISOString(),
  };
  if (fields.status) patch.status = fields.status;
  const { error } = await supabaseAdmin()
    .from("leadshark_automations")
    .update(patch)
    .eq("workspace_id", workspaceId)
    .eq("id", id);
  throwOnDbError(error);
  if (fields.incrementAttempts) {
    // Read-modify-write is safe here: the binding job holds the background-job
    // lease, so exactly one worker touches a given automation at a time. (This
    // counter is diagnostic — the real retry budget is the job's max_attempts.)
    const current = await getAutomationById(workspaceId, id);
    if (current) {
      const { error: incErr } = await supabaseAdmin()
        .from("leadshark_automations")
        .update({ bind_attempts: current.bindAttempts + 1 })
        .eq("workspace_id", workspaceId)
        .eq("id", id);
      throwOnDbError(incErr);
    }
  }
}
