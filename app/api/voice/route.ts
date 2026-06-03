import { NextResponse, after } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { authorHandleFromProfileUrl } from "@/lib/linkedin-url";
import { runProfileHistory, pickProfileMeta } from "@/lib/apify";
import { sanitizeVoiceProfile, synthesizeVoice, VOICE_MODEL } from "@/lib/claude";
import { recoverStalePending } from "@/lib/voice-recovery";

export const runtime = "nodejs";
// One run = an Apify scrape + a Sonnet synthesis call, end to end. The scrape is
// the slow, variable part: a 50-post LinkedIn history can take well over a
// minute, and with a cold start + slow synthesis the whole flow occasionally
// blew past the old 120s cap and returned a gateway 504. We run on Vercel Pro
// (fluid compute), whose ceiling is 300s — so we give the synchronous flow the
// full budget. The scrape itself is independently bounded (see runProfileHistory
// in lib/apify) so a hung actor surfaces a clean error well before this cap.
export const maxDuration = 300;

// How long before a workspace may regenerate its voice profile. The first run
// is always allowed (no generated_at yet); after a successful run we gate
// regeneration to once per week to cap the ~$0.19 scrape+synthesis cost.
const REGEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// How many of the user's recent posts to analyze.
const VOICE_POST_COUNT = 50;

const VOICE_COLS =
  "id, linkedin_handle, profile_url, display_name, avatar_url, headline, profile, summary, source_post_count, status, error, model, generated_at, created_at, pending_started_at";

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

    // Recover a run that died mid-flight (tab closed/reloaded/navigated away):
    // a row stuck `pending` past the staleness ceiling is flipped to `failed`
    // so the client stops spinning forever and offers a retry.
    const row = await recoverStalePending(sb, data ?? null);

    const cooldown = regenCooldown(row?.generated_at as string | null | undefined);
    return NextResponse.json({ ok: true, voice: row ?? null, ...cooldown });
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
//
// ASYNC: the slow work (scrape -> synthesize -> upsert) can take well over a
// minute, and waiting for it inline meant a slow LinkedIn history occasionally
// blew past the function cap and returned a gateway 504 to the client. Instead
// we validate, mark the row `pending`, schedule the work via `after()` (it runs
// after the response is flushed, within the route's maxDuration budget), and
// return the pending row IMMEDIATELY. The client never waits on the scrape, so
// it can never see a 504 — it just polls GET (already implemented) until the row
// flips to `ready`/`failed`, with the stale-pending guard recovering any run
// that dies mid-flight. The 300s maxDuration + bounded scrape still apply to the
// background work as belt-and-suspenders.
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
      .select("id, linkedin_handle, profile_url, generated_at, status, pending_started_at")
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

    // Guard against double-submits: if a run is already in flight (and not
    // stale), don't kick off a second scrape. A genuinely stuck run is recovered
    // first so the user isn't blocked forever by a dead one.
    const recovered = await recoverStalePending(sb, existing ?? null);
    if (recovered?.status === "pending") {
      return NextResponse.json(
        { ok: false, error: "A voice generation is already in progress." },
        { status: 409 },
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

    // Mark pending up front so the polling GET (and the page's first paint) can
    // show progress immediately. Keeps the unique row.
    const { data: pendingRow, error: pendErr } = await sb.raw
      .from("voice_profiles")
      .upsert(
        {
          workspace_id: sb.workspaceId,
          linkedin_handle: handle,
          profile_url: profileUrl,
          status: "pending",
          error: null,
          // Stamp the start of THIS run so a read path can detect (and recover)
          // a run that dies mid-flight. Cleared again on success/failure.
          pending_started_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id" },
      )
      .select(VOICE_COLS)
      .single();
    if (pendErr) throw pendErr;

    // Schedule the heavy work to run AFTER the response is flushed. `sb.raw` is
    // the service-role admin client (not request-bound auth), so it stays valid
    // here; we capture sb + workspaceId rather than re-deriving auth post-
    // response. Errors inside flip the row to `failed` — they can't reach the
    // client, which is already polling.
    after(() => runVoiceGeneration(sb, handle, profileUrl));

    // Return the pending row immediately (202 Accepted). The client renders the
    // loading state and polls GET until the row settles.
    return NextResponse.json(
      {
        ok: true,
        voice: pendingRow,
        ...regenCooldown(pendingRow.generated_at as string | null),
      },
      { status: 202 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

// The heavy voice-generation work: scrape the creator's history, synthesize the
// profile, and upsert the row to `ready` — or flip it to `failed` with a clear
// message on any error. Designed to run in the background via `after()`, so it
// returns nothing and never throws to a caller: every failure path lands in the
// row's `status`/`error`, which the polling client surfaces. The bounded scrape
// (lib/apify) + the route's 300s maxDuration keep this from running away.
async function runVoiceGeneration(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
  handle: string,
  profileUrl: string,
): Promise<void> {
  try {
    let posts;
    try {
      posts = await runProfileHistory(handle, VOICE_POST_COUNT);
    } catch (e) {
      await markFailed(sb, `Couldn't fetch posts for that profile: ${(e as Error).message}`);
      return;
    }
    // Keep only text-bearing posts (media-only posts are useless for voice).
    // We pass the full objects — not just the body — so synthesizeVoice can
    // rank by engagement and anchor exemplars on the best-performing posts.
    const samples = posts.filter((p) => Boolean(p.text && p.text.trim()));
    if (samples.length === 0) {
      await markFailed(
        sb,
        "We couldn't read any posts from that profile. Check the URL is correct and the profile is public.",
      );
      return;
    }

    let profile;
    try {
      profile = await synthesizeVoice(
        samples.map((p) => ({ text: p.text, reactions: p.reactions, comments: p.comments })),
      );
    } catch (e) {
      await markFailed(sb, `Voice synthesis failed: ${(e as Error).message}`);
      return;
    }

    // Display metadata for the profile card (name/avatar/headline), best-effort
    // from the scraped batch. Null fields are fine — the card falls back to an
    // initials avatar + the handle.
    const meta = pickProfileMeta(posts);

    const { error: upErr } = await sb.raw
      .from("voice_profiles")
      .upsert(
        {
          workspace_id: sb.workspaceId,
          linkedin_handle: handle,
          profile_url: profileUrl,
          display_name: meta.name,
          avatar_url: meta.avatar_url,
          headline: meta.headline,
          profile,
          summary: profile.summary || null,
          source_post_count: samples.length,
          status: "ready",
          error: null,
          model: VOICE_MODEL,
          generated_at: new Date().toISOString(),
          // Run finished — clear the in-flight marker so it can't read as stale.
          pending_started_at: null,
        },
        { onConflict: "workspace_id" },
      );
    if (upErr) {
      // Synthesis succeeded but the write failed — surface it as a failure so
      // the user can retry rather than spinning on a row that never settles.
      await markFailed(sb, `Couldn't save the voice profile: ${upErr.message}`);
    }
  } catch (e) {
    // Last-ditch: any unexpected error still settles the row.
    await markFailed(sb, `Voice generation failed: ${(e as Error).message}`);
  }
}

// -----------------------------------------------------------------------------
// PATCH /api/voice  — save hand-edits to an existing voice profile.
//
// Editing is text-only (no scrape, no LLM call), so it's free: it does NOT
// touch generated_at and is NOT subject to the regenerate cooldown. We require
// a profile to already exist (you can't edit what hasn't been generated) and
// re-sanitize the incoming profile so a hand-edit is normalized exactly like a
// synthesized one. The top-level `summary` column is kept in sync with
// profile.summary so get_voice and the page header stay consistent.
// -----------------------------------------------------------------------------
const patchSchema = z.object({
  // The full edited profile. Loosely typed here; sanitizeVoiceProfile coerces
  // every field, drops junk, and enforces the array caps.
  profile: z.record(z.string(), z.unknown()),
});

export async function PATCH(req: Request) {
  try {
    const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const sb = await scopedSupabase();

    // Must have a generated profile to edit.
    const { data: existing, error: readErr } = await sb.raw
      .from("voice_profiles")
      .select("id, status")
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (readErr) throw readErr;
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

    const { data: saved, error: upErr } = await sb.raw
      .from("voice_profiles")
      .update({
        profile,
        summary: profile.summary,
        // Deliberately NOT updating generated_at — edits don't reset the
        // regenerate cooldown, and the "last updated" date reflects the last
        // synthesis, not a text tweak.
      })
      .eq("workspace_id", sb.workspaceId)
      .select(VOICE_COLS)
      .single();
    if (upErr) throw upErr;

    // Echo the (unchanged) cooldown so the client can refresh its state in one
    // shape, identical to GET/POST.
    return NextResponse.json({
      ok: true,
      voice: saved,
      ...regenCooldown(saved.generated_at as string | null),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// Flip the row to failed with a message. Best-effort: this runs in the
// background (via `after()`), so there's no response to return — the polling
// client reads the failed status + message. A write failure here is swallowed
// (logged by Supabase); the stale-pending guard is the final backstop.
async function markFailed(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
  message: string,
): Promise<void> {
  await sb.raw
    .from("voice_profiles")
    .update({ status: "failed", error: message, pending_started_at: null })
    .eq("workspace_id", sb.workspaceId);
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
