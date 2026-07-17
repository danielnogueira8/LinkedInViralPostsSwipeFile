import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { checkChatRateLimit } from "@/lib/agent/rate-limit";
import {
  styleRegenCooldown,
  recoverStaleGeneratingStyle,
} from "@/lib/creator-styles-cooldown";

export const runtime = "nodejs";
export const maxDuration = 30;

// -----------------------------------------------------------------------------
// POST /api/creator-styles/[id]/regenerate — re-distill an existing style from
// the same source (its stored source_account_id, or its saved-post references).
// Flips the row to 'generating' and queues a background job. Workspace-scoped: the
// row is fetched by (id, workspace_id) → 404 otherwise, so a client can't
// regenerate another workspace's style.
//
// Cost guards (each regenerate is a paid Apify fetch + LLM synthesis):
//   1. Monthly budget check (checkChatRateLimit) — same ceiling as chat/voice.
//   2. In-flight dedupe — if the row is already 'generating' (and not a dead,
//      stale run), a rapid second POST is a no-op, so a double-click can't fire
//      two Apify runs.
//   3. 30-day cooldown off the last successful generation — no repeated spend on
//      the same style.
// -----------------------------------------------------------------------------
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();

    // Load the row (scoped) — its source, status, and last-generated time.
    const { data: rowRaw } = await sb.raw
      .from("creator_style_profiles")
      .select("id, source_account_id, status, generated_at, generating_started_at, created_at")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (!rowRaw) {
      return NextResponse.json({ ok: false, error: "Style not found" }, { status: 404 });
    }

    // Recover a run that died mid-flight FIRST, so a genuinely-stuck 'generating'
    // row isn't treated as a live in-flight run below (which would wedge
    // regenerate forever). Returns the row flipped to 'failed' if it was stale.
    const row = await recoverStaleGeneratingStyle(sb, rowRaw);

    // In-flight dedupe: a live 'generating' run means a regenerate is already
    // happening — a second POST (double-click) must NOT start another paid run.
    if (row.status === "generating") {
      return NextResponse.json(
        { ok: false, error: "This style is already being generated." },
        { status: 409 },
      );
    }

    // 30-day cooldown off the last SUCCESSFUL generation.
    const cooldown = styleRegenCooldown(row.generated_at as string | null);
    if (!cooldown.canRegenerate) {
      return NextResponse.json(
        {
          ok: false,
          error: `You can regenerate this style again in ${cooldown.daysUntilRegen} day${
            cooldown.daysUntilRegen === 1 ? "" : "s"
          }.`,
          regenAvailableAt: cooldown.regenAvailableAt,
        },
        { status: 429 },
      );
    }

    // Monthly budget guard (same ceiling as chat/voice).
    const limit = await checkChatRateLimit(sb.workspaceId);
    if (!limit.ok) {
      return NextResponse.json(
        { ok: false, error: limit.message ?? "You've hit your usage limit for this period." },
        { status: 429 },
      );
    }

    const sourceAccountId = (row.source_account_id as string | null) ?? null;
    let savedPostIds: string[] | null = null;
    if (!sourceAccountId) {
      const { data: srcs } = await sb.raw
        .from("creator_style_profile_sources")
        .select("saved_post_id")
        .eq("profile_id", id)
        .eq("workspace_id", sb.workspaceId)
        .not("saved_post_id", "is", null);
      savedPostIds = ((srcs ?? []) as Array<{ saved_post_id: string | null }>)
        .map((s) => s.saved_post_id)
        .filter((x): x is string => !!x);
    }

    // Flip to generating (clears the prior error) and stamp the run start so a
    // future dead run can be recovered as stale. The .eq("status", ...) below is
    // a compare-and-swap: only ONE of two racing regenerates wins the flip, so
    // even a sub-millisecond double-POST can't launch two background jobs.
    const runToken = new Date().toISOString();
    const { data: claimed } = await sb.raw
      .from("creator_style_profiles")
      .update({
        status: "generating",
        error: null,
        generating_started_at: runToken,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .neq("status", "generating")
      .select("id")
      .maybeSingle();
    if (!claimed) {
      // Lost the race to a concurrent regenerate — it owns the run.
      return NextResponse.json(
        { ok: false, error: "This style is already being generated." },
        { status: 409 },
      );
    }

    try {
      await enqueueBackgroundJob({
        workspaceId: sb.workspaceId,
        type: "creator_style_generation",
        payload: {
          profileId: id,
          sourceAccountId,
          savedPostIds,
          runToken,
        },
        progress: { stage: "Queued", profileId: id },
        sb: sb.raw,
      });
    } catch (e) {
      await markCreatorStyleQueueFailed(sb, id);
      throw e;
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

async function markCreatorStyleQueueFailed(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
  profileId: string,
): Promise<void> {
  await sb.raw
    .from("creator_style_profiles")
    .update({
      status: "failed",
      error: "We couldn't queue creator style generation. Please try again.",
      generating_started_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", profileId)
    .eq("workspace_id", sb.workspaceId)
    .eq("status", "generating");
}
