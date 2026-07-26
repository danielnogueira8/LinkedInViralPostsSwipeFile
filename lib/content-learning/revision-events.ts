import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  revisionEventSchema,
  type RevisionEvent,
} from "@/lib/content-learning/contracts";

export const REVISION_DISTILLER_PROCESSOR =
  "voice_edit_distiller_v2" as const;

const claimRowSchema = z
  .object({
    claim_token: z.string().uuid(),
    batch_id: z.string().uuid(),
    distillation_result: z.unknown().nullable(),
    id: z.string().uuid(),
    workspace_id: z.string().trim().min(1).max(200),
    source_artifact_id: z.string().trim().min(1).max(200),
    saved_artifact_id: z.string().uuid().nullable(),
    lineage_id: z.string().uuid().nullable(),
    before_body: z.string(),
    after_body: z.string(),
    edit_origin: z.enum([
      "cowork_artifact",
      "posts_editor",
      "unknown",
    ]),
    before_hash: z.string(),
    after_hash: z.string(),
    change_summary: z.unknown(),
    created_at: z.string(),
  })
  .strict();

export type RevisionEventClaim = {
  token: string;
  batchId: string;
  savedResult: unknown | null;
  events: RevisionEvent[];
};

function revisionEventFromClaimRow(
  raw: z.infer<typeof claimRowSchema>,
): RevisionEvent {
  return revisionEventSchema.parse({
    schemaVersion: 1,
    id: raw.id,
    workspaceId: raw.workspace_id,
    artifactId: raw.source_artifact_id,
    savedDraftId: raw.saved_artifact_id,
    lineageId: raw.lineage_id,
    beforeBody: raw.before_body,
    afterBody: raw.after_body,
    editOrigin: raw.edit_origin,
    beforeHash: raw.before_hash,
    afterHash: raw.after_hash,
    changeSummary: raw.change_summary,
    createdAt: raw.created_at,
  });
}

export async function releaseRevisionEventClaim(
  sb: SupabaseClient,
  workspaceId: string,
  token: string,
  processor: string = REVISION_DISTILLER_PROCESSOR,
): Promise<boolean> {
  const { data, error } = await sb.rpc("release_draft_edit_event_batch", {
    p_workspace_id: workspaceId,
    p_processor: processor,
    p_claim_token: token,
  });
  if (error) throw error;
  return data === true;
}

export async function claimRevisionEventBatch(
  sb: SupabaseClient,
  workspaceId: string,
  options: {
    processor?: string;
    limit?: number;
    leaseSeconds?: number;
  } = {},
): Promise<RevisionEventClaim | null> {
  const processor = options.processor ?? REVISION_DISTILLER_PROCESSOR;
  const { data, error } = await sb.rpc("claim_draft_edit_event_batch", {
    p_workspace_id: workspaceId,
    p_processor: processor,
    p_limit: options.limit ?? 20,
    p_lease_seconds: options.leaseSeconds ?? 120,
  });
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) return null;

  let token: string | null = null;
  try {
    const rows = data.map((row) => claimRowSchema.parse(row));
    token = rows[0]?.claim_token ?? null;
    const batchId = rows[0]?.batch_id ?? null;
    const savedResult = rows[0]?.distillation_result ?? null;
    if (
      !token ||
      !batchId ||
      rows.some(
        (row) =>
          row.claim_token !== token ||
          row.batch_id !== batchId ||
          JSON.stringify(row.distillation_result) !==
            JSON.stringify(savedResult),
      )
    ) {
      throw new Error("Revision-event claim returned inconsistent batch state");
    }
    return {
      token,
      batchId,
      savedResult,
      events: rows.map(revisionEventFromClaimRow),
    };
  } catch (error) {
    const possibleToken =
      token ??
      (typeof data[0]?.claim_token === "string"
        ? data[0].claim_token
        : null);
    if (possibleToken) {
      try {
        await releaseRevisionEventClaim(
          sb,
          workspaceId,
          possibleToken,
          processor,
        );
      } catch (releaseError) {
        console.warn("[content-learning] invalid revision claim release failed", {
          workspaceId,
          error:
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
        });
      }
    }
    throw error;
  }
}

export async function completeRevisionEventClaim(
  sb: SupabaseClient,
  workspaceId: string,
  claim: RevisionEventClaim,
  processor: string = REVISION_DISTILLER_PROCESSOR,
): Promise<boolean> {
  const lastEvent = claim.events[claim.events.length - 1];
  if (!lastEvent) return false;
  const { data, error } = await sb.rpc("complete_draft_edit_event_batch", {
    p_workspace_id: workspaceId,
    p_processor: processor,
    p_claim_token: claim.token,
  });
  if (error) throw error;
  return data === true;
}

export async function persistRevisionEventClaimResult(
  sb: SupabaseClient,
  workspaceId: string,
  claim: RevisionEventClaim,
  result: { rules: string[] },
  processor: string = REVISION_DISTILLER_PROCESSOR,
): Promise<boolean> {
  const { data, error } = await sb.rpc(
    "persist_draft_edit_event_batch_result",
    {
      p_workspace_id: workspaceId,
      p_processor: processor,
      p_claim_token: claim.token,
      p_batch_id: claim.batchId,
      p_result: result,
    },
  );
  if (error) throw error;
  return data === true;
}

export async function listWorkspacesWithPendingRevisionEvents(
  sb: SupabaseClient,
  limit = 20,
  processor: string = REVISION_DISTILLER_PROCESSOR,
): Promise<string[]> {
  const { data, error } = await sb.rpc(
    "list_workspaces_with_pending_revision_events",
    {
      p_processor: processor,
      p_limit: limit,
    },
  );
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const workspaceId = (row as { workspace_id?: unknown }).workspace_id;
    return typeof workspaceId === "string" && workspaceId.trim()
      ? [workspaceId]
      : [];
  });
}
