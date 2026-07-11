import { NextResponse } from "next/server";
import { sweepDeletedMedia } from "@/lib/media-sweep";
import { postCronAlert } from "@/lib/cron-alert";

export const runtime = "nodejs";
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// GET /api/cron/sweep-media — the media-asset garbage collector. Runs daily
// (vercel.json); hard-deletes storage + row for soft-deleted media_assets that
// (a) have passed the grace period AND (b) no chat_artifacts.media_attachments
// still references. An asset that's still referenced is left soft-deleted
// (never re-purged automatically) rather than guessed at.
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
    const summary = await sweepDeletedMedia();
    console.log(JSON.stringify({ sweep_media_cron: summary }));
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("sweep-media cron failed", (e as Error).message);
    await postCronAlert({ cron: "sweep-media" }, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
