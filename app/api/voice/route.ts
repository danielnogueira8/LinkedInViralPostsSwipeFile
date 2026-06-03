import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { authorHandleFromProfileUrl } from "@/lib/linkedin-url";
import { runProfileHistory } from "@/lib/apify";
import { synthesizeVoice, VOICE_MODEL } from "@/lib/claude";

export const runtime = "nodejs";
// One run = an Apify scrape (~10-15s for 50 posts) + a Sonnet synthesis call
// (~5-10s). Bump well past the default 10s so a cold lambda + slow LinkedIn
// doesn't time out mid-generation.
export const maxDuration = 120;

// How long before a workspace may regenerate its voice profile. The first run
// is always allowed (no generated_at yet); after a successful run we gate
// regeneration to once per week to cap the ~$0.19 scrape+synthesis cost.
const REGEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// How many of the user's recent posts to analyze.
const VOICE_POST_COUNT = 50;

const VOICE_COLS =
  "id, linkedin_handle, profile_url, profile, summary, source_post_count, status, error, model, generated_at, created_at";

// -----------------------------------------------------------------------------
// GET /api/voice  — read this workspace's voice profile (or null if none yet).
// Also surfaces whether a regenerate is currently allowed + when it unlocks.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("voice_profiles")
      .select(VOICE_COLS)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (error) throw error;

    const cooldown = regenCooldown(data?.generated_at as string | null | undefined);
    return NextResponse.json({ ok: true, voice: data ?? null, ...cooldown });
  } catch (e) {
    return errorResponse(e);
  }
}

const bodySchema = z.object({
  // The user's LinkedIn profile URL or bare handle. Optional: when omitted we
  // fall back to the handle already stored on the row (a regenerate).
  profile_url: z.string().trim().optional(),
});

// -----------------------------------------------------------------------------
// POST /api/voice  — (re)generate the voice profile from ~50 recent posts.
// Synchronous: scrape -> synthesize -> upsert. Returns the ready profile.
// -----------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const sb = await scopedSupabase();

    // Existing row (for regenerate cooldown + handle fallback).
    const { data: existing } = await sb.raw
      .from("voice_profiles")
      .select("id, linkedin_handle, profile_url, generated_at")
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();

    // Cooldown: only gate once a profile has been successfully generated.
    const cooldown = regenCooldown(existing?.generated_at as string | null | undefined);
    if (existing?.generated_at && !cooldown.canRegenerate) {
      return NextResponse.json(
        {
          ok: false,
          error: `You can refresh your voice again in ${cooldown.daysUntilRegen} day(s).`,
          regenAvailableAt: cooldown.regenAvailableAt,
        },
        { status: 429 },
      );
    }

    // Resolve the handle: a pasted profile URL wins; otherwise reuse the
    // stored handle (regenerate without re-entering the URL).
    const handle = resolveHandle(
      parsed.data.profile_url,
      existing?.linkedin_handle as string | null | undefined,
    );
    if (!handle) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Enter your LinkedIn profile URL (e.g. https://www.linkedin.com/in/your-handle/).",
        },
        { status: 400 },
      );
    }
    const profileUrl = `https://www.linkedin.com/in/${handle}/`;

    // Mark pending up front so a concurrent GET (and a future onboarding
    // fire-and-forget caller) can show progress. Keeps the unique row.
    await sb.raw
      .from("voice_profiles")
      .upsert(
        {
          workspace_id: sb.workspaceId,
          linkedin_handle: handle,
          profile_url: profileUrl,
          status: "pending",
          error: null,
        },
        { onConflict: "workspace_id" },
      );

    let posts;
    try {
      posts = await runProfileHistory(handle, VOICE_POST_COUNT);
    } catch (e) {
      return await fail(sb, `Couldn't fetch posts for that profile: ${(e as Error).message}`);
    }
    const texts = posts
      .map((p) => p.text)
      .filter((t): t is string => Boolean(t && t.trim()));
    if (texts.length === 0) {
      return await fail(
        sb,
        "We couldn't read any posts from that profile. Check the URL is correct and the profile is public.",
      );
    }

    let profile;
    try {
      profile = await synthesizeVoice(texts);
    } catch (e) {
      return await fail(sb, `Voice synthesis failed: ${(e as Error).message}`);
    }

    const { data: saved, error: upErr } = await sb.raw
      .from("voice_profiles")
      .upsert(
        {
          workspace_id: sb.workspaceId,
          linkedin_handle: handle,
          profile_url: profileUrl,
          profile,
          summary: profile.summary || null,
          source_post_count: texts.length,
          status: "ready",
          error: null,
          model: VOICE_MODEL,
          generated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id" },
      )
      .select(VOICE_COLS)
      .single();
    if (upErr) throw upErr;

    return NextResponse.json({ ok: true, voice: saved });
  } catch (e) {
    return errorResponse(e);
  }
}

// Flip the row to failed with a message, and return the 502 envelope. Best
// effort — a write failure here shouldn't mask the original error.
async function fail(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
  message: string,
): Promise<NextResponse> {
  await sb.raw
    .from("voice_profiles")
    .update({ status: "failed", error: message })
    .eq("workspace_id", sb.workspaceId);
  return NextResponse.json({ ok: false, error: message }, { status: 502 });
}

// Parse a handle from a pasted profile URL or bare slug; fall back to the
// stored handle. Returns a lowercased slug or null.
function resolveHandle(
  raw: string | undefined,
  stored: string | null | undefined,
): string | null {
  const input = (raw ?? "").trim();
  if (input) {
    // Full /in/<handle>/ URL.
    const fromUrl = authorHandleFromProfileUrl(input);
    if (fromUrl) return fromUrl;
    // Bare handle (no URL): accept a plausible slug, reject anything URL-ish
    // we couldn't parse (avoids treating a post URL as a handle).
    if (!input.includes("/") && /^[a-z0-9-]{2,100}$/i.test(input)) {
      return input.toLowerCase();
    }
    return null;
  }
  return stored ? stored.toLowerCase() : null;
}

// Compute regenerate availability from the last successful generation time.
function regenCooldown(generatedAt: string | null | undefined): {
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
