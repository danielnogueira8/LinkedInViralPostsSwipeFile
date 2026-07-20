import { NextResponse } from "next/server";
import { runWeeklyPatternBriefs } from "@/lib/batch/pattern-brief";
import { postCronAlert } from "@/lib/cron-alert";

export const runtime = "nodejs";
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// GET /api/cron/pattern-briefs — the weekly "what's working now" pattern miner
// (viral-learning loop, PR 4). For every workspace with tracked accounts, sample
// its viral vs. underperforming scraped posts and ask Sonnet to distill the
// STRUCTURAL patterns that separate them into a short editable brief, stored in
// the settings KV and surfaced to drafting agents as context on what's working.
//
// Runs weekly (vercel.json). Per-workspace failures are swallowed inside
// runWeeklyPatternBriefs (a workspace with too little signal is skipped), so one
// bad workspace never fails the whole run. runWeeklyPatternBriefs also
// self-stops before this route's maxDuration would kill it mid-flight; a run
// that hits the deadline logs it and returns deadlineHit:true rather than
// getting hard-killed with no summary. Same CRON_SECRET Bearer auth as the
// other cron routes.
// -----------------------------------------------------------------------------
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runWeeklyPatternBriefs();
    console.log(JSON.stringify({ pattern_briefs_cron: summary }));
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("pattern-briefs cron failed", (e as Error).message);
    await postCronAlert({ cron: "pattern-briefs" }, e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
