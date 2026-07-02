import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { checkChatRateLimit } from "@/lib/agent/rate-limit";
import {
  batchCooldown,
  runWeeklyBatch,
  createBatchRun,
  updateBatchRun,
  latestBatchRun,
} from "@/lib/batch/weekly";

export const runtime = "nodejs";
// The batch makes up to ~6 sequential GLM calls (5 drafts + a retry or two). On
// Vercel Pro that fits well within the 300s ceiling, and we run it in `after()`
// so the client isn't held open for it — see below.
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// GET /api/batch/weekly — the poll surface. Returns the workspace's latest run
// (live stage + counters) so the client can render step-by-step progress and a
// settlement toast. Recovers a stale run (after() died) so the UI never spins
// forever. Null run → the workspace has never run a batch.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const workspaceId = await requireWorkspaceId();
    const run = await latestBatchRun(workspaceId, Date.now());
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// POST /api/batch/weekly — generate this week's content batch for the workspace.
//
// The user clicks "Generate this week's batch" on the drafts board. We:
//   1. scope to their workspace (Clerk org) — so every write carries the real
//      workspace_id and RLS applies; no service-role footgun.
//   2. cost pre-check (checkChatRateLimit) — fail closed if over the monthly cap.
//   3. cooldown — at most one batch per 7 days (cost + board-clutter guard).
//   4. create a batch_runs row (the poll surface), kick the pipeline off in
//      after(), and return the run id immediately. The client polls GET for
//      live progress + a settlement toast; the board revalidates so new drafts
//      appear on refresh.
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

    // One id for BOTH the run rollup and the batch (its slots + artifact
    // provenance), so the poll (which reads the run row) can hand the client the
    // batchId it needs to fetch the worker lanes — no correlation column.
    const batchId = crypto.randomUUID();
    const nowIso = new Date(now).toISOString();

    // Create the run row up front (id = batchId) so the client can poll it
    // immediately, even before the after() task starts writing progress.
    const runId = await createBatchRun(workspaceId, batchId);

    // Run the pipeline after the response is sent. Progress is published to the
    // run row (the client polls GET); a thrown error flips the row to 'failed'
    // so the UI surfaces it instead of spinning forever.
    after(async () => {
      try {
        const result = await runWeeklyBatch({
          workspaceId,
          batchId,
          nowIso,
          runId: runId ?? undefined,
        });
        revalidatePath("/dashboard/posts");
        console.log(
          JSON.stringify({
            weekly_batch: {
              workspace_id: workspaceId,
              batch_id: batchId,
              run_id: runId,
              attempted: result.attempted,
              created: result.drafts.length,
              reason: result.reason ?? null,
            },
          }),
        );
      } catch (e) {
        if (runId) {
          await updateBatchRun(runId, workspaceId, {
            status: "failed",
            stage: "Something went wrong",
            error:
              "We hit a snag generating your batch. Please try again in a bit.",
            finished: true,
          });
        }
        console.error("weekly_batch failed", (e as Error).message);
        console.log(
          JSON.stringify({
            weekly_batch_error: {
              workspace_id: workspaceId,
              batch_id: batchId,
              run_id: runId,
              error: (e as Error).message,
            },
          }),
        );
      }
    });

    // Accepted — generation is running. The client polls GET /api/batch/weekly
    // for live progress and a settlement toast.
    return NextResponse.json({ ok: true, batchId, runId, status: "generating" });
  } catch (e) {
    return errorResponse(e);
  }
}
