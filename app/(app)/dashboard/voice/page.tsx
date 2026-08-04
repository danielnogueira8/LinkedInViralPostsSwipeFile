import { scopedSupabase } from "@/lib/supabase-scoped";
import { sanitizeVoiceProfile, type VoiceProfile } from "@/lib/claude";
import { recoverStalePending } from "@/lib/voice-recovery";
import type { VoiceRow } from "./manager";
import { VoiceWorkspace } from "./workspace";
import { PageHeader, PageShell } from "@/components/app-surface";

export const dynamic = "force-dynamic";

// The same cooldown the API enforces (lib mirror would be ideal, but keeping
// the page self-contained avoids importing the route module). One week.
const REGEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const VOICE_COLS =
  "id, linkedin_handle, profile_url, display_name, avatar_url, headline, profile, summary, source_post_count, status, error, model, generated_at, created_at, pending_started_at";

export default async function VoicePage() {
  const sb = await scopedSupabase();

  const voicePromise = sb.raw
    .from("voice_profiles")
    .select(VOICE_COLS)
    .eq("workspace_id", sb.workspaceId)
    .maybeSingle();

  const [{ data }] = await Promise.all([
    voicePromise,
  ]);

  // Recover a generation that died mid-flight (tab closed/reloaded mid-run)
  // before the first paint, so a hard reload onto a stuck `pending` row shows a
  // retryable error instead of an eternal "Analyzing…" spinner. The GET route
  // applies the same guard for the client poll.
  const recoveredRow = await recoverStalePending(
    sb,
    (data ?? null) as VoiceRow | null,
  );
  // Profiles generated before new writing-pattern fields were introduced are
  // normalized on read so the UI gets safe empty defaults until regeneration.
  const row = recoveredRow?.profile
    ? { ...recoveredRow, profile: sanitizeVoiceProfile(recoveredRow.profile) }
    : recoveredRow;
  const cooldown = regenCooldown(row?.generated_at ?? null);

  return (
    <PageShell width="wide">
      <PageHeader
        title="Voice"
        description="Teach Cowork how you write—from your profile, exemplars, and standing rules."
      />
      <VoiceWorkspace
        initialRow={row}
        canRegenerate={cooldown.canRegenerate}
        regenAvailableAt={cooldown.regenAvailableAt}
        daysUntilRegen={cooldown.daysUntilRegen}
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
