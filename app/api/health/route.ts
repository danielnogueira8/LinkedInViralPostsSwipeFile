import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// Public liveness/health check for external uptime monitors (Vercel monitors,
// UptimeRobot, BetterStack, etc.). Unauthenticated ON PURPOSE — a monitor can't
// hold a Clerk session — and exempted from the Clerk middleware in proxy.ts.
//
// It confirms the two things that most often break silently in prod: the
// serverless function runs at all, and the database is reachable. It does NOT
// touch tenant data (a trivial count on a global table), so there's nothing to
// leak. On a DB failure it returns 503 so the monitor flips red and pages you —
// turning "blind to an outage" into "alerted on an outage".
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    // Cheapest possible DB round-trip: a head-only count on a small global
    // table. `head: true` fetches no rows, just proves the connection + query
    // path work. 4s cap so a hung DB surfaces as unhealthy instead of hanging
    // the monitor.
    const sb = supabaseAdmin();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    const { error } = await sb
      .from("settings")
      .select("key", { count: "exact", head: true })
      .abortSignal(ac.signal);
    clearTimeout(timer);

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          db: "down",
          error: error.message,
          latency_ms: Date.now() - startedAt,
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      ok: true,
      db: "up",
      latency_ms: Date.now() - startedAt,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        db: "down",
        error: (e as Error).message,
        latency_ms: Date.now() - startedAt,
      },
      { status: 503 },
    );
  }
}
