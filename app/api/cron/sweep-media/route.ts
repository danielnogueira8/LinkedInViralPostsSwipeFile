import { NextResponse } from "next/server";
import { sweepDeletedMedia } from "@/lib/media-sweep";
import { purgeExpiredModeledDraftBatches } from "@/lib/modeled-draft-batch-retention";
import { postCronAlert } from "@/lib/cron-alert";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// GET /api/cron/sweep-media — bounded daily retention maintenance. The media
// sweep hard-deletes only unreferenced assets past their grace period. In the
// same scheduled tick, the database RPC removes at most 1,000 modeled-draft
// batches past their seven-day retention window. The RPC itself preserves
// active, unexpired leases.
//
// Same CRON_SECRET Bearer auth as the other cron routes.
// -----------------------------------------------------------------------------
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const [mediaSweep, modeledBatchSweep] = await Promise.allSettled([
      sweepDeletedMedia(),
      purgeExpiredModeledDraftBatches(),
    ]);
    if (mediaSweep.status === "rejected") throw mediaSweep.reason;
    if (modeledBatchSweep.status === "rejected") {
      throw modeledBatchSweep.reason;
    }
    const summary = mediaSweep.value;
    const modeledBatchRetention = modeledBatchSweep.value;
    console.log(
      JSON.stringify({
        sweep_media_cron: summary,
        modeled_draft_batch_retention: modeledBatchRetention,
      }),
    );
    return NextResponse.json({
      ok: true,
      ...summary,
      modeledDraftBatchesDeleted: modeledBatchRetention.deleted,
    });
  } catch (e) {
    console.error("sweep-media cron failed", (e as Error).message);
    await postCronAlert({ cron: "sweep-media" }, e);
    return errorResponse(e);
  }
}
