import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { sanitizeVoiceProfile, type VoiceProfile } from "@/lib/claude";
import { synthesizeInterviewContext } from "@/lib/voice-interview";
import {
  checkChatCostAllowance,
  VOICE_JOB_COST_RESERVE_USD,
} from "@/lib/agent/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

const VOICE_COLS =
  "id, linkedin_handle, profile_url, display_name, avatar_url, headline, profile, summary, source_post_count, status, error, model, generated_at, created_at, pending_started_at";

const bodySchema = z.object({
  answers: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .max(15),
});

// -----------------------------------------------------------------------------
// POST /api/voice/interview — run the context interview: take the user's
// (skippable) answers, synthesize them INTO the user's voice, and merge the
// result onto the voice profile's `profile` JSON (interview_answers = raw source
// of truth, interview_context = the always-on drafting context).
//
// Standalone-safe: if the workspace has no voice profile yet, a MINIMAL ready
// row is created holding just the interview data (a placeholder summary), so
// the interview works before a scrape. Synchronous — one ~10s synthesis call,
// much cheaper than the scrape+synthesis in POST /api/voice.
// -----------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const sb = await scopedSupabase();

    // Cost cap — the synthesis call spends, so gate it like other LLM writes.
    const limit = await checkChatCostAllowance(sb.workspaceId, VOICE_JOB_COST_RESERVE_USD);
    if (!limit.ok) {
      return NextResponse.json({ ok: false, error: limit.message }, { status: 429 });
    }

    // Current profile (may be absent — standalone case).
    const { data: existing, error: readErr } = await sb.raw
      .from("voice_profiles")
      .select("id, status, profile, summary")
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (readErr) throw readErr;

    const currentProfile: VoiceProfile | null =
      existing?.status === "ready" && existing.profile
        ? sanitizeVoiceProfile(existing.profile)
        : null;

    const { answers, context } = await synthesizeInterviewContext({
      answers: parsed.data.answers,
      voice: currentProfile,
      workspaceId: sb.workspaceId,
    });

    // Merge interview fields onto the profile. Empty answers (all skipped) clear
    // any prior interview data rather than leaving stale content.
    const nextProfile: VoiceProfile = sanitizeVoiceProfile({
      ...(currentProfile ?? {}),
      interview_answers: answers,
      interview_context: context,
    });
    // Guarantee a non-empty summary for the row (standalone profiles have none).
    const summary =
      nextProfile.summary ||
      "Context interview completed — answers are used to write in your voice.";

    let saved;
    if (existing) {
      const { data, error } = await sb.raw
        .from("voice_profiles")
        .update({ profile: nextProfile, summary })
        .eq("workspace_id", sb.workspaceId)
        .select(VOICE_COLS)
        .single();
      if (error) throw error;
      saved = data;
    } else {
      // Standalone: create a minimal ready row that carries only the interview.
      const { data, error } = await sb.raw
        .from("voice_profiles")
        .insert({
          workspace_id: sb.workspaceId,
          status: "ready",
          profile: nextProfile,
          summary,
          model: "interview",
          generated_at: new Date().toISOString(),
        })
        .select(VOICE_COLS)
        .single();
      if (error) throw error;
      saved = data;
    }

    return NextResponse.json({ ok: true, voice: saved, context });
  } catch (e) {
    return errorResponse(e);
  }
}
