import { PageHeader, PageShell } from "@/components/app-surface";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { sanitizeVoiceProfile } from "@/lib/claude";
import { createWorkspaceKnowledgeStore } from "@/lib/content-learning/workspace-knowledge";
import { interviewKnowledgeSourcePrefix } from "@/lib/content-learning/interview-knowledge";
import { chatInterviewKnowledgeSourcePrefix } from "@/lib/content-learning/chat-interview-knowledge";
import {
  publicKnowledgeSource,
  type KnowledgeSourceSummary,
  type StoredKnowledgeSource,
} from "@/lib/knowledge-sources/types";
import type { VoiceRow } from "../voice/manager";
import { KnowledgeWorkspace } from "./knowledge-workspace";

export const dynamic = "force-dynamic";

const VOICE_COLS =
  "id, linkedin_handle, profile_url, display_name, avatar_url, headline, profile, summary, source_post_count, status, error, model, generated_at, created_at, pending_started_at";

export default async function KnowledgePage() {
  const sb = await scopedSupabase();
  const [markerResult, voiceResult] = await Promise.all([
    sb.raw
      .from("app_schema_version")
      .select("version")
      .eq("singleton", true)
      .maybeSingle(),
    sb.raw
      .from("voice_profiles")
      .select(VOICE_COLS)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle(),
  ]);
  const { data: marker, error: markerError } = markerResult;
  if (markerError) throw markerError;
  if (voiceResult.error) throw voiceResult.error;

  const rawVoice = (voiceResult.data ?? null) as VoiceRow | null;
  const voice = rawVoice?.profile
    ? { ...rawVoice, profile: sanitizeVoiceProfile(rawVoice.profile) }
    : rawVoice;
  const available =
    typeof marker?.version === "number" && marker.version >= 148;
  const extractionAvailable =
    typeof marker?.version === "number" && marker.version >= 149;
  const retryAvailable =
    typeof marker?.version === "number" && marker.version >= 152;
  const knowledgeStore = createWorkspaceKnowledgeStore(sb.raw);
  const [sources, formInterviewKnowledge, chatInterviewKnowledge] = await Promise.all([
    (async (): Promise<KnowledgeSourceSummary[]> => {
      if (!available) return [];
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
      return ((data ?? []) as unknown as StoredKnowledgeSource[]).map(
        publicKnowledgeSource,
      );
    })(),
    voice?.id
      ? knowledgeStore.listActiveBySource(
          sb.workspaceId,
          "interview",
          interviewKnowledgeSourcePrefix(String(voice.id)),
        )
      : Promise.resolve([]),
    // Chat interviews ("Interview me" in Cowork) accumulate under a separate
    // workspace-keyed prefix — they show up in the same review card, labelled
    // by provenance.
    knowledgeStore.listActiveBySource(
      sb.workspaceId,
      "interview",
      chatInterviewKnowledgeSourcePrefix(sb.workspaceId),
    ),
  ]);
  const interviewKnowledge = [...formInterviewKnowledge, ...chatInterviewKnowledge];
  const knowledgeProposals = interviewKnowledge.filter(
    (item) => item.verification === "proposed",
  );
  const verifiedKnowledge = interviewKnowledge.filter(
    (item) => item.verification === "verified",
  );

  return (
    <PageShell width="wide">
      <PageHeader
        title="Knowledge"
        description="Give Cowork durable context—your interview, customer calls, research, frameworks, and notes—without making it public."
      />
      <KnowledgeWorkspace
        initialSources={sources}
        available={available}
        extractionAvailable={extractionAvailable}
        retryAvailable={retryAvailable}
        initialVoice={voice}
        knowledgeProposals={knowledgeProposals}
        verifiedKnowledge={verifiedKnowledge}
      />
    </PageShell>
  );
}
