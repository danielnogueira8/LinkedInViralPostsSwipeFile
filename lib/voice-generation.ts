import type { SupabaseClient } from "@supabase/supabase-js";
import { runProfileHistory, pickProfileMeta } from "@/lib/apify";
import { sanitizeVoiceProfile, synthesizeVoice, VOICE_MODEL } from "@/lib/claude";
import { computeMechanicsFingerprint } from "@/lib/voice-mechanics";
import { classifyPost } from "@/lib/post-type";
import { mirrorAvatarToStorage } from "@/lib/avatar-mirror";

type VoiceGenerationDb = {
  workspaceId: string;
  raw: SupabaseClient;
};

// How many of the user's recent posts to analyze.
const VOICE_POST_COUNT = 50;
// Minimum text-bearing posts needed to synthesize a meaningful voice. Below
// this the model overfits to a tiny sample and emits a generic/misleading
// profile, so we fail with guidance instead of saving junk.
const MIN_VOICE_SAMPLES = 5;

// The heavy voice-generation work: scrape the creator's history, synthesize the
// profile, and upsert the row to `ready` — or flip it to `failed` with a clear
// message on any error. Designed for background jobs; it never throws to its
// caller for ordinary provider/model failures because the polling UI reads the
// row's `status`/`error`.
export async function runVoiceGeneration(
  sb: VoiceGenerationDb,
  handle: string,
  profileUrl: string,
  runToken: string,
): Promise<void> {
  try {
    let posts;
    try {
      posts = await runProfileHistory(handle, VOICE_POST_COUNT, { includeMetadataOnly: true });
    } catch (e) {
      await markVoiceGenerationFailed(
        sb,
        `Couldn't fetch posts for that profile: ${(e as Error).message}`,
        runToken,
      );
      return;
    }
    const samples = posts.filter((p) => Boolean(p.text && p.text.trim()));
    if (samples.length === 0) {
      await markVoiceGenerationFailed(
        sb,
        "We couldn't read any posts from that profile. Check the URL is correct and the profile is public.",
        runToken,
      );
      return;
    }
    if (samples.length < MIN_VOICE_SAMPLES) {
      await markVoiceGenerationFailed(
        sb,
        `We only found ${samples.length} text post(s) for that profile — we need at least ${MIN_VOICE_SAMPLES} to learn your voice. Post a few more times (or check the profile is public) and try again.`,
        runToken,
      );
      return;
    }

    // Deterministic mechanics fingerprint — measured in code, not synthesized
    // by the model (see lib/voice-mechanics.ts for why). Computed BEFORE
    // synthesis so the measured numbers can anchor the model's qualitative
    // read (synthesizeVoice includes them as ground truth), from the same
    // REGULAR-post subset synthesizeVoice uses for its core exemplars
    // (excludes lead-magnet posts, whose CTA mechanics aren't how the person
    // writes normally). Never blocks generation: a failure here just means
    // synthesis runs unanchored and the profile ships without a fingerprint.
    let fingerprint;
    try {
      const regularBodies = samples
        .filter((p) => classifyPost(p.text).post_type !== "lead_magnet")
        .map((p) => p.text!.trim());
      const fingerprintSource = regularBodies.length > 0 ? regularBodies : samples.map((p) => p.text!.trim());
      fingerprint = computeMechanicsFingerprint(fingerprintSource);
    } catch (e) {
      console.warn("voice: mechanics fingerprint computation failed, continuing without it", e);
    }

    let profile;
    try {
      profile = await synthesizeVoice(
        samples.map((p) => ({
          text: p.text,
          reactions: p.reactions,
          comments: p.comments,
        })),
        sb.workspaceId,
        { mechanicsFingerprint: fingerprint },
      );
    } catch (e) {
      await markVoiceGenerationFailed(
        sb,
        `Voice synthesis failed: ${(e as Error).message}`,
        runToken,
      );
      return;
    }
    if (fingerprint) profile.mechanics_fingerprint = fingerprint;

    const meta = pickProfileMeta(posts);
    // A context interview can complete while this generation run is still in
    // flight (both write the same row). Interview answers/context live inside
    // `profile` too, but this synthesis never produces them — re-read the
    // row's current values right before writing so this success write can't
    // silently erase interview data saved mid-run.
    const { data: preWrite } = await sb.raw
      .from("voice_profiles")
      .select("profile, avatar_url")
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    const existingProfile = preWrite?.profile as
      | { interview_answers?: unknown; interview_context?: unknown }
      | null
      | undefined;
    if (existingProfile?.interview_answers !== undefined) {
      profile.interview_answers = existingProfile.interview_answers as typeof profile.interview_answers;
    }
    if (existingProfile?.interview_context !== undefined) {
      profile.interview_context = existingProfile.interview_context as typeof profile.interview_context;
    }

    // Copy the avatar into our own bucket while the provider URL still works.
    // LinkedIn's CDN URLs expire, and nothing re-scrapes a workspace's own
    // profile to refresh them, so storing the provider URL guarantees the
    // avatar breaks eventually. Fail-open: a null mirror keeps exactly the old
    // behavior rather than risking the generation this is a side-effect of.
    const providerAvatarUrl = validAvatarUrl(meta.avatar_url)
      ? meta.avatar_url
      : null;
    const mirroredAvatarUrl = providerAvatarUrl
      ? await mirrorAvatarToStorage(providerAvatarUrl, sb.workspaceId)
      : null;

    const { data: updated, error: upErr } = await sb.raw
      .from("voice_profiles")
      .update({
        linkedin_handle: handle,
        profile_url: profileUrl,
        display_name: meta.name,
        avatar_url:
          mirroredAvatarUrl ?? providerAvatarUrl ?? preWrite?.avatar_url ?? null,
        headline: meta.headline,
        profile,
        summary: profile.summary || null,
        source_post_count: samples.length,
        status: "ready",
        error: null,
        model: VOICE_MODEL,
        generated_at: new Date().toISOString(),
        pending_started_at: null,
      })
      .eq("workspace_id", sb.workspaceId)
      .eq("status", "pending")
      .eq("pending_started_at", runToken)
      .select("id");
    if (upErr) {
      await markVoiceGenerationFailed(
        sb,
        `Couldn't save the voice profile: ${upErr.message}`,
        runToken,
      );
    } else if (!updated || updated.length === 0) {
      console.warn("voice: stale run result dropped (superseded)", { handle });
    }
  } catch (e) {
    await markVoiceGenerationFailed(
      sb,
      `Voice generation failed: ${(e as Error).message}`,
      runToken,
    );
  }
}

export async function markVoiceGenerationFailed(
  sb: VoiceGenerationDb,
  message: string,
  runToken: string,
): Promise<void> {
  await sb.raw
    .from("voice_profiles")
    .update({
      status: "failed",
      error: message,
      pending_started_at: null,
      failed_at: new Date().toISOString(),
    })
    .eq("workspace_id", sb.workspaceId)
    .eq("status", "pending")
    .eq("pending_started_at", runToken);
}

export { sanitizeVoiceProfile };

function validAvatarUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    console.warn("voice: ignoring invalid provider avatar URL");
    return false;
  }
}
