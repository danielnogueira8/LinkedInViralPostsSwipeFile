import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { authorHandleFromProfileUrl } from "@/lib/linkedin-url";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { sanitizeVoiceProfile } from "@/lib/voice-generation";
import { recoverStalePending } from "@/lib/voice-recovery";
import {
  checkChatCostAllowance,
  VOICE_JOB_COST_RESERVE_USD,
} from "@/lib/agent/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

// How long before a workspace may regenerate its voice profile. The first run
// is always allowed (no generated_at yet); after a successful run we gate
// regeneration to once per week to cap the ~$0.19 scrape+synthesis cost.
const REGEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// Short backoff after a FAILED run before another may start. The 7-day cooldown
// only engages on success; without this a profile that fails just past
// validation could be re-POSTed in a tight loop, re-running the expensive Apify
// scrape + GLM-5.2 synthesis each time. 60s caps the loop rate while keeping a
// legitimate retry (e.g. a corrected URL) effectively immediate from the user's
// perspective.
const FAILED_RETRY_BACKOFF_MS = 60 * 1000;
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
// minute, so this route only validates, marks the row `pending`, enqueues a
// durable background job, and returns immediately. The client keeps polling GET
// until the row flips to `ready`/`failed`.
// -----------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const sb = await scopedSupabase();

    // Monthly cost cap. Voice synthesis is the single most expensive operation in
    // the app (an Apify scrape + an 8000-token GLM-5.2 reasoning call ~$0.19),
    // so it must respect the same money ceiling as chat. Uses the allowance
    // variant that ACCOUNTS FOR the estimated job cost, so a workspace at
    // $4.90 spent can't kick off an ~$0.20 job that tips them over $5.
    const limit = await checkChatCostAllowance(
      sb.workspaceId,
      VOICE_JOB_COST_RESERVE_USD,
    );
    if (!limit.ok) {
      return NextResponse.json(
        { ok: false, error: limit.message },
        {
          status: 429,
          headers: limit.retryAfterSec
            ? { "Retry-After": String(limit.retryAfterSec) }
            : undefined,
        },
      );
    }

    // Existing row (for regenerate cooldown + handle fallback).
    const { data: existing } = await sb.raw
      .from("voice_profiles")
      .select(
        "id, linkedin_handle, profile_url, generated_at, status, pending_started_at, failed_at",
      )
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();

    // Short retry backoff after a recent failure, so a profile that fails just
    // past validation can't be re-POSTed in a tight loop to burn scrape + model
    // spend. Independent of the 7-day success cooldown below.
    const failedAt = existing?.failed_at as string | null | undefined;
    if (failedAt) {
      const sinceFail = Date.now() - new Date(failedAt).getTime();
      if (sinceFail >= 0 && sinceFail < FAILED_RETRY_BACKOFF_MS) {
        return NextResponse.json(
          {
            ok: false,
            error: "That just failed — give it a few seconds and try again.",
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(
                Math.ceil((FAILED_RETRY_BACKOFF_MS - sinceFail) / 1000),
              ),
            },
          },
        );
      }
    }

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
          // Clear any prior failure marker now the backoff has been satisfied and
          // a fresh run is starting — it only gates the gap between runs.
          failed_at: null,
          // Stamp the start of THIS run so a read path can detect (and recover)
          // a run that dies mid-flight. Cleared again on success/failure.
          pending_started_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id" },
      )
      .select(VOICE_COLS)
      .single();
    if (pendErr) throw pendErr;

    // Queue the heavy work. The run token scopes all background writes to THIS
    // pending row so a slow/stale job can never clobber a newer retry.
    const runToken = pendingRow.pending_started_at as string;
    try {
      await enqueueBackgroundJob({
        workspaceId: sb.workspaceId,
        type: "voice_generation",
        payload: { handle, profileUrl, runToken },
        progress: { stage: "Queued", handle },
        sb: sb.raw,
      });
    } catch (e) {
      await markVoiceQueueFailed(sb, runToken);
      throw e;
    }

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

async function markVoiceQueueFailed(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
  runToken: string,
): Promise<void> {
  await sb.raw
    .from("voice_profiles")
    .update({
      status: "failed",
      error: "We couldn't queue voice generation. Please try again.",
      pending_started_at: null,
      failed_at: new Date().toISOString(),
    })
    .eq("workspace_id", sb.workspaceId)
    .eq("status", "pending")
    .eq("pending_started_at", runToken);
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
