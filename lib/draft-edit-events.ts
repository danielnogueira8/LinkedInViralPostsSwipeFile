import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type {
  RevisionChangeSummary,
  RevisionEditOrigin,
} from "@/lib/content-learning/contracts";

// ---------------------------------------------------------------------------
// Draft edit events (PLAN-agent-loop Phase C1).
//
// Persist the user's manual edits to drafts so the voice-edit distiller can
// learn from them later. This table is intentionally dumb: a plain series of
// before/after bodies, queried by workspace + recency.
// ---------------------------------------------------------------------------

export type DraftEditEventInput = {
  sb: SupabaseClient;
  workspaceId: string;
  artifactId: string;
  beforeBody: string;
  afterBody: string;
  editOrigin?: RevisionEditOrigin;
};

export function summarizeDraftRevision(
  beforeBody: string,
  afterBody: string,
): RevisionChangeSummary {
  const beforeLines = beforeBody.length === 0 ? 0 : beforeBody.split("\n").length;
  const afterLines = afterBody.length === 0 ? 0 : afterBody.split("\n").length;
  return {
    beforeChars: beforeBody.length,
    afterChars: afterBody.length,
    deltaChars: afterBody.length - beforeBody.length,
    beforeLines,
    afterLines,
    deltaLines: afterLines - beforeLines,
  };
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Record one manual edit. Fail-open: an insert error is logged but never
 * fails the edit itself.
 */
export async function recordDraftEditEvent({
  sb,
  workspaceId,
  artifactId,
  beforeBody,
  afterBody,
  editOrigin = "unknown",
}: DraftEditEventInput): Promise<void> {
  if (
    !workspaceId.trim() ||
    !artifactId.trim() ||
    beforeBody === afterBody
  ) {
    return;
  }

  try {
    const { error } = await sb.from("draft_edit_events").insert({
      schema_version: 1,
      workspace_id: workspaceId,
      source_artifact_id: artifactId,
      saved_artifact_id: null,
      lineage_id: null,
      before_body: beforeBody,
      after_body: afterBody,
      edit_origin: editOrigin,
      before_hash: bodyHash(beforeBody),
      after_hash: bodyHash(afterBody),
      change_summary: summarizeDraftRevision(beforeBody, afterBody),
    });
    if (error) throw error;
  } catch (error) {
    console.warn(
      "recordDraftEditEvent failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
