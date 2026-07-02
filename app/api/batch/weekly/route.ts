import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { checkChatRateLimit } from "@/lib/agent/rate-limit";
import { batchCooldown, runWeeklyBatch } from "@/lib/batch/weekly";

export const runtime = "nodejs";
// The batch makes up to ~6 sequential GLM calls (5 drafts + a retry or two). On
// Vercel Pro that fits well within the 300s ceiling, and we run it in `after()`
// so the client isn't held open for it — see below.
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// POST /api/batch/weekly — generate this week's content batch for the workspace.
//
// The user clicks "Generate this week's batch" on the drafts board. We:
//   1. scope to their workspace (Clerk org) — so every write carries the real
//      workspace_id and RLS applies; no service-role footgun.
//   2. cost pre-check (checkChatRateLimit) — fail closed if over the monthly cap.
//   3. cooldown — at most one batch per 7 days (cost + board-clutter guard).
//   4. kick the pipeline off in after() and return immediately. The board is
//      client-rendered and revalidated; the drafts appear on the next load / a
//      client refresh. (PR 2 adds a status endpoint + live poll + toast.)
//
// Returning immediately (not awaiting the ~30-60s generation) keeps the request
// snappy and dodges any gateway timeout, mirroring the voice-generation route.
// -----------------------------------------------------------------------------
export async function POST() {
  try {
    const workspaceId = await requireWorkspaceId();

    // Cost cap first — never start paid work for a workspace over budget.
    const rl = await checkChatRateLimit(workspaceId);
    if (!rl.ok) {
      return NextResponse.json(
        { ok: false, error: rl.message, reason: rl.reason },
        { status: 429 },
      );
    }

    // Cooldown — one batch per 7 days. Derived from the last batch draft, so no
    // extra state table (v1). Blocks a double-run + bounds cost.
    const now = Date.now();
    const cd = await batchCooldown(workspaceId, now);
    if (!cd.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "You've already generated a batch this week. Your next one unlocks soon.",
          reason: "cooldown",
          retryAt: cd.retryAtIso,
        },
        { status: 429 },
      );
    }

    const batchId = crypto.randomUUID();
    const nowIso = new Date(now).toISOString();

    // Run the pipeline after the response is sent. A failure here is logged but
    // can't surface to this (already-returned) response — PR 2's status endpoint
    // is where settlement (added N / quiet week / error) gets reported. For v1
    // the drafts simply appear on the board on the next load.
    after(async () => {
      try {
        const result = await runWeeklyBatch({ workspaceId, batchId, nowIso });
        revalidatePath("/dashboard/posts");
        console.log(
          JSON.stringify({
            weekly_batch: {
              workspace_id: workspaceId,
              batch_id: batchId,
              attempted: result.attempted,
              created: result.drafts.length,
              reason: result.reason ?? null,
            },
          }),
        );
      } catch (e) {
        console.error("weekly_batch failed", (e as Error).message);
        console.log(
          JSON.stringify({
            weekly_batch_error: {
              workspace_id: workspaceId,
              batch_id: batchId,
              error: (e as Error).message,
            },
          }),
        );
      }
    });

    // Accepted — generation is running. The client shows a "generating…" state
    // and refreshes the board shortly (PR 2 makes this a real poll + toast).
    return NextResponse.json({ ok: true, batchId, status: "generating" });
  } catch (e) {
    return errorResponse(e);
  }
}
