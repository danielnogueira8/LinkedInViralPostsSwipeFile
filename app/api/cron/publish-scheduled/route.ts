import { NextResponse } from "next/server";
import { publishDueDrafts } from "@/lib/draft-publishing";
import { postCronAlert } from "@/lib/cron-alert";
import { errorResponse } from "@/lib/workspace";
import {
  cronAuthorizationResponse,
  isCronAuthorized,
} from "@/app/api/cron/_auth";

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
  if (!isCronAuthorized(req)) return cronAuthorizationResponse();
  try {
    const summary = await publishDueDrafts(new Date().toISOString());
    console.log(JSON.stringify({ publish_scheduled_cron: summary }));
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("publish-scheduled cron failed", (e as Error).message);
    // Alert on failure: this cron publishes users' scheduled LinkedIn posts, so
    // a silent break means posts quietly never go out. Best-effort; never throws.
    await postCronAlert({ cron: "publish-scheduled" }, e);
    return errorResponse(e);
  }
}
