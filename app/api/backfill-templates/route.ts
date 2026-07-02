import { NextResponse } from "next/server";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// RETIRED. This admin endpoint ran Claude across every viral post missing an
// old post-derived template (real Anthropic billing). That `templates` table
// is no longer surfaced anywhere — see app/api/templates/route.ts for the full
// context. Kept as a 410 so a stale caller doesn't silently kick off a paid
// backfill.
// -----------------------------------------------------------------------------
export function POST() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "This endpoint is retired. Post-derived template backfill is gone; the Templates page uses the content-templates library now.",
    },
    { status: 410 },
  );
}
