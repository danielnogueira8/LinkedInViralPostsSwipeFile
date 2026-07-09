import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import {
  checkChatCostAllowance,
  BATCH_JOB_COST_RESERVE_USD,
} from "@/lib/agent/rate-limit";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import {
  batchInFlight,
  createBatchRun,
  createBatchChat,
  updateBatchRun,
  latestBatchRun,
} from "@/lib/batch/weekly";

export const runtime = "nodejs";
export const maxDuration = 30;

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
//   2. cost pre-check (checkChatCostAllowance with the batch estimate) — fail
//      closed if the workspace can't afford ~$0.30 of batch cost within the
//      monthly cap (the ONLY spend limit; batches are otherwise unlimited).
//   3. in-flight guard — refuse a 2nd batch while one is already running.
//   4. create a batch_runs row (the poll surface), enqueue durable background
//      work, and return the run id immediately. The client polls GET for live
//      progress + a settlement toast; the board revalidates when the job runs.
//
// Returning immediately keeps the request snappy. The cron worker owns the
// model calls, so provider pressure queues work instead of killing a request.
// -----------------------------------------------------------------------------
export async function POST() {
  try {
    const workspaceId = await requireWorkspaceId();
    const authResult = await auth();
    const userId = authResult.userId;
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
    }

    // Cost cap first — never start paid work for a workspace over budget.
    // Uses the allowance variant that accounts for the ~$0.30 batch cost
    // (7 posts × ~$0.045), so a workspace at $4.75 spent can't kick off a
    // batch that would tip them well past the $5 monthly cap.
    const rl = await checkChatCostAllowance(workspaceId, BATCH_JOB_COST_RESERVE_USD);
    if (!rl.ok) {
      return NextResponse.json(
        { ok: false, error: rl.message, reason: rl.reason },
        { status: 429 },
      );
    }

    // In-flight guard (NOT a cooldown). Batches are unlimited — the monthly
    // credit cap above is the only spend limit — but we still refuse to start a
    // SECOND batch while one is already running, so a rapid double-click can't
    // double-spend or drop two overlapping sets on the board. Clears the instant
    // the running batch settles.
    const now = Date.now();
    if (await batchInFlight(workspaceId, now)) {
      return NextResponse.json(
        {
          ok: false,
          error: "A batch is already running. Give it a moment to finish.",
          reason: "in_flight",
        },
        { status: 409 },
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

    // Batch-as-chat: create a Cowork chat + intro message NOW (before after()),
    // so the client can navigate straight into a live-looking session. The
    // drafts stream into this chat as the pipeline files them. If chat creation
    // fails, we fall back to a headless run (chatId undefined) — the batch still
    // works, it just isn't shown as a chat.
    //
    // Title format: "Weekly batch — {Mon D}" (e.g. "Weekly batch — Jul 3"). We
    // used to stamp the raw ISO date ("2026-07-03") which read as machine
    // metadata inside a sidebar of human-authored conversation names. Formatted
    // in en-US on the SERVER — the sidebar is a shared workspace list, so it
    // must render the same way for every viewer no matter where they are.
    // en-GB would put day first ("3 Jul") and confuse North-American users
    // who make up the majority of the workspace. The chat_workspace.tsx
    // batch-chat detector still keys off the "Weekly batch — " prefix, which
    // this change preserves.
    const weekOfLabel = new Date(nowIso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const chatId =
      (await createBatchChat(workspaceId, `Weekly batch — ${weekOfLabel}`)) ??
      undefined;

    let jobId: string | null = null;
    try {
      const job = await enqueueBackgroundJob({
        workspaceId,
        type: "weekly_batch",
        payload: {
          batchId,
          runId,
          chatId,
          userId,
          nowIso,
        },
        progress: {
          stage: "Queued",
          batchId,
          runId,
          chatId,
        },
      });
      jobId = job.id;
    } catch (e) {
      if (runId) {
        await updateBatchRun(runId, workspaceId, {
          status: "failed",
          stage: "Queue unavailable",
          error:
            "We couldn't queue your batch. Please try again in a moment.",
          finished: true,
        });
      }
      throw e;
    }

    // Accepted — generation is queued. Return chatId so the client can navigate
    // into the Cowork session and watch the drafts stream in once the worker
    // claims capacity.
    return NextResponse.json({
      ok: true,
      jobId,
      batchId,
      runId,
      chatId,
      status: "queued",
    });
  } catch (e) {
    return errorResponse(e);
  }
}
