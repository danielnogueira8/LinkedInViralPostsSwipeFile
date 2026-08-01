import type { SupabaseClient } from "@supabase/supabase-js";
import { KNOWLEDGE_SOURCE_BUCKET } from "@/lib/knowledge-sources/ingestion";

type KnowledgeSourceFailureInput = {
  db: SupabaseClient;
  workspaceId: string;
  sourceId: string;
  storagePath: string;
  errorCode: string;
};

/**
 * Keep the source lifecycle authoritative even when storage cleanup is
 * unavailable. The database failure transition is the state callers poll;
 * object removal is cleanup and can be retried independently.
 */
export async function failKnowledgeSourceUpload({
  db,
  workspaceId,
  sourceId,
  storagePath,
  errorCode,
}: KnowledgeSourceFailureInput): Promise<void> {
  const { error: removeError } = await db.storage
    .from(KNOWLEDGE_SOURCE_BUCKET)
    .remove([storagePath]);
  if (removeError) {
    console.error("knowledge source upload cleanup failed", {
      sourceId,
      error:
        removeError instanceof Error ? removeError.message : String(removeError),
    });
  }

  const { error: failError } = await db.rpc(
    "fail_knowledge_source_ingestion",
    {
      p_workspace_id: workspaceId,
      p_source_id: sourceId,
      p_error_code: errorCode,
      p_job_id: null,
    },
  );
  if (failError) throw failError;
}
