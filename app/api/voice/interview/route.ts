import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { sanitizeVoiceProfile, type VoiceProfile } from "@/lib/claude";
import { synthesizeInterviewContext } from "@/lib/voice-interview";
import {
  checkChatCostAllowance,
  VOICE_JOB_COST_RESERVE_USD,
  MONTHLY_BUDGET_USD,
} from "@/lib/agent/rate-limit";
import {
  claimAiOperation,
  releaseAiOperation,
} from "@/lib/ai-operation-claims";
import {
  claimWorkspaceCost,
  releaseWorkspaceCost,
} from "@/lib/workspace-cost-claims";

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
  let operationClaim: { workspaceId: string; claimId: string } | null = null;
  let costClaim: { workspaceId: string; operationKey: string } | null = null;
  let succeeded = false;
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const sb = await scopedSupabase();

    // Serialize concurrent submits. Without this, a double-submit (two tabs, a
    // retry after a slow response) is a pure read-then-spend race: both requests
    // pass the same stale cost snapshot below and BOTH run the paid synthesis.
    // Mirrors POST /api/voice's claim; short TTL — this route is synchronous
    // (~10s call), so a stale claim clears quickly even if a request dies.
    const claimId = await claimAiOperation({
      workspaceId: sb.workspaceId,
      operationKey: "voice-interview",
      ttlSeconds: 2 * 60,
    });
    if (!claimId) {
      return NextResponse.json(
        { ok: false, error: "An interview synthesis is already running — give it a few seconds." },
        { status: 409 },
      );
    }
    operationClaim = { workspaceId: sb.workspaceId, claimId };

    // Cost cap — the synthesis call spends, so gate it like other LLM writes.
    const limit = await checkChatCostAllowance(sb.workspaceId, VOICE_JOB_COST_RESERVE_USD);
    if (!limit.ok) {
      return NextResponse.json({ ok: false, error: limit.message }, { status: 429 });
    }
    const costOperationKey = `voice-interview:${claimId}`;
    const workspaceCostClaim = await claimWorkspaceCost({
      workspaceId: sb.workspaceId,
      operationKey: costOperationKey,
      estimatedCostUsd: VOICE_JOB_COST_RESERVE_USD,
      budgetUsd: MONTHLY_BUDGET_USD,
      ttlSeconds: 2 * 60,
    });
    if (!workspaceCostClaim) {
      return NextResponse.json(
        { ok: false, reason: "monthly", error: "Monthly AI budget reached." },
        { status: 429 },
      );
    }
    costClaim = { workspaceId: sb.workspaceId, operationKey: costOperationKey };

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

    succeeded = true;
    return NextResponse.json({ ok: true, voice: saved, context });
  } catch (e) {
    return errorResponse(e);
  } finally {
    // Always free the claim — the route is synchronous, so by the time we're
    // here the paid call is done (or failed) either way. Never throws.
    if (operationClaim) await releaseAiOperation(operationClaim).catch(() => {});
    if (succeeded && costClaim) {
      await releaseWorkspaceCost(costClaim).catch((error) => {
        console.error("Failed to release completed voice interview cost claim", error);
      });
    }
  }
}
