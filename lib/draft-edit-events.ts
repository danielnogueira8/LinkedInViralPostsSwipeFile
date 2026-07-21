import type { SupabaseClient } from "@supabase/supabase-js";

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
};

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
}: DraftEditEventInput): Promise<void> {
  const before = beforeBody.trim();
  const after = afterBody.trim();
  if (!artifactId.trim() || !before || !after || before === after) return;
  try {
    const { error } = await sb.from("draft_edit_events").insert({
      workspace_id: workspaceId,
      artifact_id: artifactId,
      before_body: before,
      after_body: after,
    });
    if (error) throw error;
  } catch (error) {
    console.warn(
      "recordDraftEditEvent failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
