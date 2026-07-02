import { scopedSupabase } from "@/lib/supabase-scoped";
import type { VoiceProfile } from "@/lib/claude";
import { recoverStalePending } from "@/lib/voice-recovery";
import { VoiceManager, type VoiceRow } from "./manager";
import { PreferencesManager } from "./preferences";
import {
  PREFS_PER_WORKSPACE_MAX,
  type ContentPreference,
} from "@/lib/preferences";

export const dynamic = "force-dynamic";

// The same cooldown the API enforces (lib mirror would be ideal, but keeping
// the page self-contained avoids importing the route module). One week.
const REGEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const VOICE_COLS =
  "id, linkedin_handle, profile_url, display_name, avatar_url, headline, profile, summary, source_post_count, status, error, model, generated_at, created_at, pending_started_at";

export default async function VoicePage() {
  const sb = await scopedSupabase();
  const { data } = await sb.raw
    .from("voice_profiles")
    .select(VOICE_COLS)
    .eq("workspace_id", sb.workspaceId)
    .maybeSingle();

  // Recover a generation that died mid-flight (tab closed/reloaded mid-run)
  // before the first paint, so a hard reload onto a stuck `pending` row shows a
  // retryable error instead of an eternal "Analyzing…" spinner. The GET route
  // applies the same guard for the client poll.
  const row = await recoverStalePending(sb, (data ?? null) as VoiceRow | null);
  const cooldown = regenCooldown(row?.generated_at ?? null);

  // The workspace's standing writing preferences — durable rules the chat agent
  // applies to every post. Read here so the manager hydrates without a client
  // fetch flash. Workspace-scoped (scopedSupabase + RLS).
  const { data: prefData } = await sb.raw
    .from("content_preferences")
    .select("id, workspace_id, rule, source, created_at, updated_at")
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false })
    .limit(PREFS_PER_WORKSPACE_MAX);
  const preferences = (prefData ?? []) as ContentPreference[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Voice</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Learn your writing voice from your last 50 LinkedIn posts, so AI-drafted
          content actually sounds like you.
        </p>
      </div>
      <VoiceManager
        initialRow={row}
        canRegenerate={cooldown.canRegenerate}
        regenAvailableAt={cooldown.regenAvailableAt}
        daysUntilRegen={cooldown.daysUntilRegen}
      />
      <PreferencesManager initial={preferences} />
    </div>
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
