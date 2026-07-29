import { PageHeader, PageShell } from "@/components/app-surface";
import { scopedSupabase } from "@/lib/supabase-scoped";
import {
  publicKnowledgeSource,
  type KnowledgeSourceSummary,
  type StoredKnowledgeSource,
} from "@/lib/knowledge-sources/types";
import { KnowledgeLibrary } from "./workspace";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const sb = await scopedSupabase();
  const { data: marker, error: markerError } = await sb.raw
    .from("app_schema_version")
    .select("version")
    .eq("singleton", true)
    .maybeSingle();
  if (markerError) throw markerError;
  const available =
    typeof marker?.version === "number" && marker.version >= 148;
  const extractionAvailable =
    typeof marker?.version === "number" && marker.version >= 149;
  const retryAvailable =
    typeof marker?.version === "number" && marker.version >= 152;
  let sources: KnowledgeSourceSummary[] = [];
  if (available) {
    const selection = extractionAvailable
      ? "id,kind,title,original_filename,mime_type,status,error_code,declared_size_bytes,ingestion_job_id,extraction_error_code,extraction_job:background_jobs!knowledge_sources_extraction_job_id_fkey(status),created_at,updated_at"
      : "id,kind,title,original_filename,mime_type,status,error_code,declared_size_bytes,ingestion_job_id,created_at,updated_at";
    const { data, error } = await sb.raw
      .from("knowledge_sources")
      .select(selection)
      .eq("workspace_id", sb.workspaceId)
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    sources = ((data ?? []) as unknown as StoredKnowledgeSource[]).map(
      publicKnowledgeSource,
    );
  }

  return (
    <PageShell width="wide">
      <PageHeader
        title="Knowledge"
        description="Give Cowork durable source material—customer calls, research, frameworks, and notes—without making it part of your public profile."
      />
      <KnowledgeLibrary
        initialSources={sources}
        available={available}
        extractionAvailable={extractionAvailable}
        retryAvailable={retryAvailable}
      />
    </PageShell>
  );
}
