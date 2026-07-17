import type { SupabaseClient } from "@supabase/supabase-js";
import { authorHandleFromProfileUrl } from "@/lib/linkedin-url";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { claimAiOperation, releaseAiOperation } from "@/lib/ai-operation-claims";
import { checkChatCostAllowance, VOICE_JOB_COST_RESERVE_USD } from "@/lib/agent/rate-limit";
import { recoverStalePending } from "@/lib/voice-recovery";

export const VOICE_REGEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const VOICE_FAILED_RETRY_BACKOFF_MS = 60 * 1000;
export const VOICE_PROFILE_COLS =
  "id, linkedin_handle, profile_url, display_name, avatar_url, headline, profile, summary, source_post_count, status, error, model, generated_at, interview_updated_at, created_at, pending_started_at";

type Failure = {
  ok: false;
  error: string;
  status: number;
  retryAfterSec?: number;
  regenAvailableAt?: string | null;
};

type Success = {
  ok: true;
  status: 202;
  voice: Record<string, unknown>;
  canRegenerate: boolean;
  regenAvailableAt: string | null;
  daysUntilRegen: number;
};

export type StartVoiceGenerationResult = Failure | Success;

export function voiceRegenCooldown(generatedAt: string | null | undefined): {
  canRegenerate: boolean;
  regenAvailableAt: string | null;
  daysUntilRegen: number;
} {
  if (!generatedAt) return { canRegenerate: true, regenAvailableAt: null, daysUntilRegen: 0 };
  const unlockMs = new Date(generatedAt).getTime() + VOICE_REGEN_COOLDOWN_MS;
  if (Date.now() >= unlockMs) return { canRegenerate: true, regenAvailableAt: null, daysUntilRegen: 0 };
  return {
    canRegenerate: false,
    regenAvailableAt: new Date(unlockMs).toISOString(),
    daysUntilRegen: Math.ceil((unlockMs - Date.now()) / (24 * 60 * 60 * 1000)),
  };
}

function resolveHandle(raw: string | undefined, stored: string | null | undefined): string | null {
  const input = (raw ?? "").trim();
  if (input) {
    const fromUrl = authorHandleFromProfileUrl(input);
    if (fromUrl) return fromUrl;
    if (!input.includes("/") && /^[a-z0-9-]{2,100}$/i.test(input)) return input.toLowerCase();
    return null;
  }
  return stored ? stored.toLowerCase() : null;
}

export async function startVoiceGeneration(input: {
  workspaceId: string;
  profileUrl?: string;
  db: SupabaseClient;
}): Promise<StartVoiceGenerationResult> {
  const { workspaceId, db } = input;
  let claimId: string | null = null;
  try {
    claimId = await claimAiOperation({ workspaceId, operationKey: "voice-generation", ttlSeconds: 15 * 60, sb: db });
    if (!claimId) return { ok: false, error: "A voice generation is already in progress.", status: 409 };

    const allowance = await checkChatCostAllowance(workspaceId, VOICE_JOB_COST_RESERVE_USD);
    if (!allowance.ok) {
      return {
        ok: false,
        error: allowance.message ?? "Voice generation is unavailable at the current usage limit.",
        status: 429,
        retryAfterSec: allowance.retryAfterSec,
      };
    }

    const { data: existing, error: readError } = await db
      .from("voice_profiles")
      .select("id, linkedin_handle, profile_url, generated_at, status, pending_started_at, failed_at, created_at")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (readError) throw readError;

    const failedAt = existing?.failed_at as string | null | undefined;
    if (failedAt) {
      const elapsed = Date.now() - new Date(failedAt).getTime();
      if (elapsed >= 0 && elapsed < VOICE_FAILED_RETRY_BACKOFF_MS) {
        return {
          ok: false,
          error: "That just failed — give it a few seconds and try again.",
          status: 429,
          retryAfterSec: Math.ceil((VOICE_FAILED_RETRY_BACKOFF_MS - elapsed) / 1000),
        };
      }
    }

    const cooldown = voiceRegenCooldown(existing?.generated_at as string | null | undefined);
    if (existing?.generated_at && !cooldown.canRegenerate) {
      return {
        ok: false,
        error: `You can refresh your voice again in ${cooldown.daysUntilRegen} day(s).`,
        status: 429,
        regenAvailableAt: cooldown.regenAvailableAt,
      };
    }

    const recovered = await recoverStalePending({ raw: db, workspaceId }, existing ?? null);
    if (recovered?.status === "pending") {
      return { ok: false, error: "A voice generation is already in progress.", status: 409 };
    }

    const handle = resolveHandle(input.profileUrl, existing?.linkedin_handle as string | null | undefined);
    if (!handle) {
      return {
        ok: false,
        error: "Enter your LinkedIn profile URL (e.g. https://www.linkedin.com/in/your-handle/).",
        status: 400,
      };
    }
    const profileUrl = `https://www.linkedin.com/in/${handle}/`;
    const runToken = new Date().toISOString();
    const { data: pending, error } = await db
      .from("voice_profiles")
      .upsert(
        { workspace_id: workspaceId, linkedin_handle: handle, profile_url: profileUrl, status: "pending", error: null, failed_at: null, pending_started_at: runToken },
        { onConflict: "workspace_id" },
      )
      .select(VOICE_PROFILE_COLS)
      .single();
    if (error) throw error;

    try {
      await enqueueBackgroundJob({ workspaceId, type: "voice_generation", payload: { handle, profileUrl, runToken }, progress: { stage: "Queued", handle }, sb: db });
    } catch (error) {
      await db
        .from("voice_profiles")
        .update({ status: "failed", error: "We couldn't queue voice generation. Please try again.", pending_started_at: null, failed_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("status", "pending")
        .eq("pending_started_at", runToken);
      throw error;
    }

    return { ok: true, status: 202, voice: pending as Record<string, unknown>, ...voiceRegenCooldown(pending.generated_at as string | null) };
  } finally {
    if (claimId) await releaseAiOperation({ workspaceId, claimId, sb: db }).catch(() => {});
  }
}
