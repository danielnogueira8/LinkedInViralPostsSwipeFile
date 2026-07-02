import { NextResponse } from "next/server";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// RETIRED. This endpoint used to Claude-templatize a viral post into the old
// post-derived `templates` table (a {placeholder} skeleton of one specific
// post) — a paid Anthropic call. Nothing surfaces that table anymore: the
// Templates page moved to the generic, workspace-owned `content_templates`
// library (built-ins + user-authored), and users model a real post via
// "Model in Chat" on the swipe file / Posts instead. The auto-templatize step
// in the daily pipeline was removed too. Kept as a 410 so any stale/cached
// caller gets a clear signal rather than silently triggering paid generation.
// -----------------------------------------------------------------------------
export function POST() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "This endpoint is retired. Templates now live in the content-templates library; use /api/content-templates or 'Model in Chat' on a post.",
    },
    { status: 410 },
  );
}
