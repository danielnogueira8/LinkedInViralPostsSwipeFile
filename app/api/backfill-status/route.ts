import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { errorResponse } from "@/lib/workspace";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/backfill-status — read a global backfill_runs row.
//
// backfill_runs is a GLOBAL, workspace-agnostic table: it records site-wide
// data-backfill jobs (the ones triggered from /api/backfill-hooks,
// /api/backfill-post-types, /api/backfill-saved-posts — all admin-only).
// The read endpoint must match: without this gate, a signed-in user in any
// workspace could enumerate arbitrary run ids and peek at global backfill
// state. Zero user-facing callers depend on this route (verified via grep),
// so restricting it to admins costs nothing and closes the leak.
export async function GET(req: NextRequest) {
  try {
    if (!(await isAdmin())) {
      return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
    }
    const sb = supabaseAdmin();
    const runId = req.nextUrl.searchParams.get("runId");
    const q = runId
      ? sb.from("backfill_runs").select("*").eq("id", runId).maybeSingle()
      : sb.from("backfill_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle();
    const { data, error } = await q;
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, run: data });
  } catch (e) {
    return errorResponse(e);
  }
}
