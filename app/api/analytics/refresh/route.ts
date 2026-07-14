import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { refreshPostAnalytics } from "@/lib/post-analytics";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

// How long a workspace must wait between manual refreshes. The daily cron
// keeps snapshots current anyway; this button exists for "I just published
// something, show me" impatience — not for hammering Zernio.
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

// -----------------------------------------------------------------------------
// POST /api/analytics/refresh — on-demand analytics refresh. Cooldown is
// enforced by a global, atomic database lease before the provider call.
// The underlying refresh is API-key-wide (one Zernio call, all workspaces),
// same as the daily cron — a manual refresh just runs it early.
// -----------------------------------------------------------------------------
export async function POST() {
  try {
    // Authenticate and resolve a real workspace before using the service-role
    // client for the global lease. The RPC itself is service-role-only.
    await scopedSupabase();
    const { data: claims, error: claimErr } = await supabaseAdmin().rpc(
      "claim_analytics_refresh",
      { p_cooldown_seconds: Math.ceil(REFRESH_COOLDOWN_MS / 1000) },
    );
    if (claimErr) throw claimErr;
    const claim = Array.isArray(claims) ? claims[0] : claims;
    if (!claim?.claimed) {
      const retryAt = claim?.retry_at ? new Date(claim.retry_at).getTime() : Date.now() + REFRESH_COOLDOWN_MS;
      const waitMin = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000));
      return NextResponse.json(
        {
          ok: false,
          error: `Analytics were refreshed recently — try again in ~${waitMin} min. (The daily refresh keeps these current automatically.)`,
        },
        { status: 429 },
      );
    }

    const summary = await refreshPostAnalytics();
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return errorResponse(e);
  }
}
