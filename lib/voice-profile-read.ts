import type { SupabaseClient } from "@supabase/supabase-js";
import { renderBackstoryBlock } from "@/lib/agent/specialists/backstory";
import type { VoiceProfile } from "@/lib/claude";
import { sanitizeVoiceProfile } from "@/lib/voice-generation";
import { createWorkspaceKnowledgeStore } from "@/lib/content-learning/workspace-knowledge";
import { renderWorkspaceKnowledgeBlock } from "@/lib/content-learning/workspace-knowledge-presentation";
import { supabaseAdmin } from "@/lib/supabase";
import {
  mechanicsFingerprintToRules,
  voiceKeepsEmDashes,
} from "@/lib/voice-mechanics";

export type ModelFacingVoiceProfile = Omit<
  VoiceProfile,
  | "biographical_facts"
  | "interview_answers"
  | "interview_context"
  | "mechanics_fingerprint"
>;

export type VoiceGuidance = {
  linkedin_handle: string | null;
  display_name: string | null;
  headline: string | null;
  summary: string | null;
  profile: ModelFacingVoiceProfile;
  backstory_guidance?: string;
  workspace_knowledge_guidance?: string;
  mechanics_rules?: string[];
  keep_em_dashes?: true;
  source_post_count: number | null;
  model: string | null;
  generated_at: string | null;
};

export type VoiceProfileStatus = "pending" | "ready" | "failed";

export type VoiceGuidanceResult =
  | { ok: true; voice: VoiceGuidance }
  | {
      ok: false;
      error: string;
      status: VoiceProfileStatus | null;
    };

export type VoiceProfileEnricher = (input: {
  workspaceId: string;
  profile: VoiceProfile;
  signal?: AbortSignal;
}) => Promise<VoiceProfile>;

export type ReadVoiceGuidanceOptions = {
  enrichProfile: VoiceProfileEnricher;
  signal?: AbortSignal;
  client?: SupabaseClient;
};

/**
 * Canonical Voice Profile read used by every delivery surface.
 *
 * The operation owns the distinction between durable profile data and
 * model-facing guidance: raw interview material and measured fingerprints
 * never leave through the profile dump, while verified Workspace Knowledge,
 * retrieval-only backstory, and deterministic mechanics are rendered through
 * their dedicated guidance fields.
 */
export async function readVoiceGuidance(
  workspaceId: string,
  options: ReadVoiceGuidanceOptions,
): Promise<VoiceGuidanceResult> {
  const sb = options.client ?? supabaseAdmin();
  const { data, error } = await sb
    .from("voice_profiles")
    .select(
      "linkedin_handle, display_name, headline, profile, summary, source_post_count, status, model, generated_at",
    )
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "ready" || !data.profile) {
    return {
      ok: false,
      error:
        "No voice profile yet. Ask the user to generate one in the Voice tab (paste their LinkedIn profile URL).",
      status:
        data?.status === "pending" ||
        data?.status === "ready" ||
        data?.status === "failed"
          ? data.status
          : null,
    };
  }

  const profile = await options.enrichProfile({
    workspaceId,
    profile: sanitizeVoiceProfile(data.profile),
    signal: options.signal,
  });
  const backstoryGuidance = renderBackstoryBlock(profile.biographical_facts);
  const workspaceKnowledgeGuidance = renderWorkspaceKnowledgeBlock(
    await createWorkspaceKnowledgeStore(sb).listActive(workspaceId),
  );
  const mechanicsRules = profile.mechanics_fingerprint
    ? mechanicsFingerprintToRules(profile.mechanics_fingerprint)
    : [];
  const {
    biographical_facts: _biographicalFacts,
    interview_answers: _interviewAnswers,
    interview_context: _interviewContext,
    mechanics_fingerprint: _mechanicsFingerprint,
    ...profileForModel
  } = profile;

  return {
    ok: true,
    voice: {
      linkedin_handle: data.linkedin_handle,
      display_name: data.display_name,
      headline: data.headline,
      summary: data.summary,
      profile: profileForModel,
      ...(backstoryGuidance ? { backstory_guidance: backstoryGuidance } : {}),
      ...(workspaceKnowledgeGuidance
        ? { workspace_knowledge_guidance: workspaceKnowledgeGuidance }
        : {}),
      ...(mechanicsRules.length ? { mechanics_rules: mechanicsRules } : {}),
      ...(voiceKeepsEmDashes(profile.mechanics_fingerprint)
        ? { keep_em_dashes: true }
        : {}),
      source_post_count: data.source_post_count,
      model: data.model,
      generated_at: data.generated_at,
    },
  };
}
