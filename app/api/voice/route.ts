import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { sanitizeVoiceProfile } from "@/lib/voice-generation";
import { recoverStalePending } from "@/lib/voice-recovery";
import {
  startVoiceGeneration,
  voiceRegenCooldown,
  VOICE_PROFILE_COLS,
} from "@/lib/voice-profile-operations";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("voice_profiles")
      .select(VOICE_PROFILE_COLS)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (error) throw error;
    const row = await recoverStalePending(sb, data ?? null);
    return NextResponse.json({
      ok: true,
      voice: row ?? null,
      ...voiceRegenCooldown(row?.generated_at as string | null | undefined),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

const bodySchema = z.object({ profile_url: z.string().trim().optional() });

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const sb = await scopedSupabase();
    const result = await startVoiceGeneration({
      workspaceId: sb.workspaceId,
      profileUrl: parsed.data.profile_url,
      db: sb.raw,
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          ...(result.regenAvailableAt !== undefined
            ? { regenAvailableAt: result.regenAvailableAt }
            : {}),
        },
        {
          status: result.status,
          headers: result.retryAfterSec
            ? { "Retry-After": String(result.retryAfterSec) }
            : undefined,
        },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        voice: result.voice,
        canRegenerate: result.canRegenerate,
        regenAvailableAt: result.regenAvailableAt,
        daysUntilRegen: result.daysUntilRegen,
      },
      { status: result.status },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

const patchSchema = z.object({
  profile: z.record(z.string(), z.unknown()),
});

export async function PATCH(req: Request) {
  try {
    const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const sb = await scopedSupabase();
    const { data: existing, error: readError } = await sb.raw
      .from("voice_profiles")
      .select("id, status")
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (readError) throw readError;
    if (!existing || existing.status !== "ready") {
      return NextResponse.json(
        { ok: false, error: "Generate a voice profile before editing it." },
        { status: 409 },
      );
    }

    const profile = sanitizeVoiceProfile(parsed.data.profile);
    if (!profile.summary) {
      return NextResponse.json(
        { ok: false, error: "The summary can't be empty." },
        { status: 400 },
      );
    }

    const { data: saved, error } = await sb.raw
      .from("voice_profiles")
      .update({ profile, summary: profile.summary })
      .eq("workspace_id", sb.workspaceId)
      .select(VOICE_PROFILE_COLS)
      .single();
    if (error) throw error;
    return NextResponse.json({
      ok: true,
      voice: saved,
      ...voiceRegenCooldown(saved.generated_at as string | null),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
