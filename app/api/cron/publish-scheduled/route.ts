import { NextResponse } from "next/server";
import { publishDueDrafts } from "@/lib/draft-publishing";
import { postCronAlert } from "@/lib/cron-alert";

export const runtime = "nodejs";
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// GET /api/cron/publish-scheduled — the LinkedIn publisher. Runs every 5 minutes
// (vercel.json); scans drafts whose schedule is due, publishes each via Zernio,
// and flips the card to 'posted'. Each row is claimed atomically before any
// Zernio call, so overlapping ticks can't double-post.
//
// Same CRON_SECRET Bearer auth as /api/cron/daily — fail CLOSED when the secret
// is unset (otherwise anyone could trigger real LinkedIn posts + Zernio spend).
// -----------------------------------------------------------------------------
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await publishDueDrafts(new Date().toISOString());
    console.log(JSON.stringify({ publish_scheduled_cron: summary }));
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("publish-scheduled cron failed", (e as Error).message);
    // Alert on failure: this cron publishes users' scheduled LinkedIn posts, so
    // a silent break means posts quietly never go out. Best-effort; never throws.
    await postCronAlert({ cron: "publish-scheduled" }, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
