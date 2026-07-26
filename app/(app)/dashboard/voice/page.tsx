import { scopedSupabase } from "@/lib/supabase-scoped";
import { sanitizeVoiceProfile, type VoiceProfile } from "@/lib/claude";
import { recoverStalePending } from "@/lib/voice-recovery";
import type { VoiceRow } from "./manager";
import { VoiceWorkspace } from "./workspace";
import {
  PREFS_PER_WORKSPACE_MAX,
  type ContentPreference,
} from "@/lib/preferences";
import { listReviewablePreferences } from "@/lib/preference-evidence";
import type { ContentFeedback } from "@/lib/content-feedback";
import { PageHeader, PageShell } from "@/components/app-surface";
import { createWorkspaceKnowledgeStore } from "@/lib/content-learning/workspace-knowledge";
import { interviewKnowledgeSourcePrefix } from "@/lib/content-learning/interview-knowledge";

export const dynamic = "force-dynamic";

// The same cooldown the API enforces (lib mirror would be ideal, but keeping
// the page self-contained avoids importing the route module). One week.
const REGEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const VOICE_COLS =
  "id, linkedin_handle, profile_url, display_name, avatar_url, headline, profile, summary, source_post_count, status, error, model, generated_at, created_at, pending_started_at";

const FEEDBACK_COLS =
  "id, workspace_id, chat_id, artifact_id, draft_id, rating, reasons, note, body_snapshot, created_at";

export default async function VoicePage() {
  const sb = await scopedSupabase();

  const voicePromise = sb.raw
    .from("voice_profiles")
    .select(VOICE_COLS)
    .eq("workspace_id", sb.workspaceId)
    .maybeSingle();

  // The workspace's standing writing preferences — durable rules the chat agent
  // applies to every post. Read here so the manager hydrates without a client
  // fetch flash. Workspace-scoped (scopedSupabase + RLS).
  const preferencesPromise = sb.raw
    .from("content_preferences")
    .select("id, workspace_id, rule, detail, source, created_at, updated_at")
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false })
    .limit(PREFS_PER_WORKSPACE_MAX);

  const feedbackPromise = sb.raw
    .from("content_feedback")
    .select(FEEDBACK_COLS)
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false })
    .limit(20);

  const [{ data }, { data: prefData }, { data: feedbackData }] = await Promise.all([
    voicePromise,
    preferencesPromise,
    feedbackPromise,
  ]);

  // Recover a generation that died mid-flight (tab closed/reloaded mid-run)
  // before the first paint, so a hard reload onto a stuck `pending` row shows a
  // retryable error instead of an eternal "Analyzing…" spinner. The GET route
  // applies the same guard for the client poll.
  const recoveredRow = await recoverStalePending(sb, (data ?? null) as VoiceRow | null);
  // Profiles generated before new writing-pattern fields were introduced are
  // normalized on read so the UI gets safe empty defaults until regeneration.
  const row = recoveredRow?.profile
    ? { ...recoveredRow, profile: sanitizeVoiceProfile(recoveredRow.profile) }
    : recoveredRow;
  const cooldown = regenCooldown(row?.generated_at ?? null);

  const preferences = await listReviewablePreferences({
    db: sb.raw,
    workspaceId: sb.workspaceId,
    preferences: (prefData ?? []) as ContentPreference[],
  });
  const feedback = (feedbackData ?? []) as ContentFeedback[];
  const knowledgeStore = createWorkspaceKnowledgeStore(sb.raw);
  // This review surface is specifically for facts sourced from the Context
  // interview. Keep future knowledge sources off this page so the provenance
  // label remains truthful and revisions only reconcile their own Voice row.
  const interviewKnowledge = row?.id
    ? await knowledgeStore.listActiveBySource(
        sb.workspaceId,
        "interview",
        interviewKnowledgeSourcePrefix(String(row.id)),
      )
    : [];
  const knowledgeProposals = interviewKnowledge.filter(
    (item) => item.verification === "proposed",
  );
  const verifiedKnowledge = interviewKnowledge.filter(
    (item) => item.verification === "verified",
  );

  return (
    <PageShell width="wide">
      <PageHeader
        title="Voice"
        description="Teach Cowork how you write — from your profile, an interview, and standing rules — all in one place."
      />
      <VoiceWorkspace
        initialRow={row}
        canRegenerate={cooldown.canRegenerate}
        regenAvailableAt={cooldown.regenAvailableAt}
        daysUntilRegen={cooldown.daysUntilRegen}
        preferences={preferences}
        feedback={feedback}
        knowledgeProposals={knowledgeProposals}
        verifiedKnowledge={verifiedKnowledge}
      />
    </PageShell>
  );
}

// Mirror of the API route's cooldown math: first run is free (no generated_at),
// then once per 7 days.
function regenCooldown(generatedAt: string | null): {
  canRegenerate: boolean;
  regenAvailableAt: string | null;
  daysUntilRegen: number;
} {
  if (!generatedAt) {
    return { canRegenerate: true, regenAvailableAt: null, daysUntilRegen: 0 };
  }
  const unlockMs = new Date(generatedAt).getTime() + REGEN_COOLDOWN_MS;
  const now = Date.now();
  if (now >= unlockMs) {
    return { canRegenerate: true, regenAvailableAt: null, daysUntilRegen: 0 };
  }
  return {
    canRegenerate: false,
    regenAvailableAt: new Date(unlockMs).toISOString(),
    daysUntilRegen: Math.ceil((unlockMs - now) / (24 * 60 * 60 * 1000)),
  };
}

// Re-export the shared row shape so the manager and page agree.
export type { VoiceProfile };
