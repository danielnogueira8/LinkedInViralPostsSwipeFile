import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export class NoWorkspaceError extends Error {
  constructor() {
    super("You're not signed in.");
    this.name = "NoWorkspaceError";
  }
}

/**
 * Map a thrown error to a JSON `{ ok: false, error }` response for API routes.
 *
 * `scopedSupabase()` calls `requireWorkspaceId()`, which throws
 * `NoWorkspaceError` when the request has no Clerk session. Routes that don't
 * catch it let the throw bubble into Next's default 500 handler, which returns
 * an HTML error page — and `fetchJson` then either mislabels it
 * `Request failed (500)` or (on some statuses) `AuthExpiredError`, hiding the
 * real cause. Funnel route errors through here so the client always gets the
 * proper envelope: 400 for the recoverable no-session case, 500 for anything
 * genuinely server-side.
 */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof NoWorkspaceError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
  return NextResponse.json(
    { ok: false, error: (e as Error)?.message ?? "Unexpected error" },
    { status: 500 },
  );
}

/**
 * Resolve the current workspace_id from the Clerk session.
 *
 * workspace_id == Clerk USER id. Each user is their own workspace (1:1); there
 * is no organization layer. (Historically workspace_id was the Clerk org_id,
 * which required an org to exist + be the active session org — that indirection
 * caused the sign-up "no personal org" wall, the select-workspace bounce, and
 * the MCP multi-org auth loop. Keying on the user id removes all of it.)
 *
 * Throws if the request has no Clerk session. Server-side only.
 */
export async function requireWorkspaceId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new NoWorkspaceError();
  return userId;
}

/**
 * Same as above but returns null instead of throwing — for routes that can
 * render a signed-out empty state instead of erroring.
 */
export async function getWorkspaceId(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}
