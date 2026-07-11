import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { refreshPostAnalytics } from "@/lib/post-analytics";

export const runtime = "nodejs";
export const maxDuration = 60;

// How long a workspace must wait between manual refreshes. The daily cron
// keeps snapshots current anyway; this button exists for "I just published
// something, show me" impatience — not for hammering Zernio.
export const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

// -----------------------------------------------------------------------------
// POST /api/analytics/refresh — on-demand analytics refresh. Cooldown is
// judged from the workspace's newest snapshot fetched_at (no extra state
// table): if anything was fetched in the last 10 minutes, refuse politely.
// The underlying refresh is API-key-wide (one Zernio call, all workspaces),
// same as the daily cron — a manual refresh just runs it early.
// -----------------------------------------------------------------------------
export async function POST() {
  try {
    const sb = await scopedSupabase();

    const { data: newest, error: newestErr } = await sb.raw
      .from("post_analytics")
      .select("fetched_at")
      .eq("workspace_id", sb.workspaceId)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (newestErr) throw newestErr;
    if (newest?.fetched_at) {
      const age = Date.now() - new Date(newest.fetched_at as string).getTime();
      if (age >= 0 && age < REFRESH_COOLDOWN_MS) {
        const waitMin = Math.ceil((REFRESH_COOLDOWN_MS - age) / 60_000);
        return NextResponse.json(
          {
            ok: false,
            error: `Analytics were refreshed recently — try again in ~${waitMin} min. (The daily refresh keeps these current automatically.)`,
          },
          { status: 429 },
        );
      }
    }

    const summary = await refreshPostAnalytics();
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return errorResponse(e);
  }
}
