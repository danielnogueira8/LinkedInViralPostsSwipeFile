import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export class NoWorkspaceError extends Error {
  constructor() {
    super("No active workspace. Create or select a Clerk organization first.");
    this.name = "NoWorkspaceError";
  }
}

/**
 * Map a thrown error to a JSON `{ ok: false, error }` response for API routes.
 *
 * `scopedSupabase()` calls `requireWorkspaceId()`, which throws
 * `NoWorkspaceError` when the session has no active org. Routes that don't
 * catch it let the throw bubble into Next's default 500 handler, which returns
 * an HTML error page — and `fetchJson` then either mislabels it
 * `Request failed (500)` or (on some statuses) `AuthExpiredError`, hiding the
 * real cause. Funnel route errors through here so the client always gets the
 * proper envelope: 400 for the recoverable no-workspace case (the user just
 * needs to select/create an org), 500 for anything genuinely server-side.
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
 * workspace_id == Clerk org_id (we don't keep a local workspaces table).
 *
 * Throws if the user has no active organization. Server-side only.
 */
export async function requireWorkspaceId(): Promise<string> {
  const { orgId } = await auth();
  if (!orgId) throw new NoWorkspaceError();
  return orgId;
}

/**
 * Same as above but returns null instead of throwing — for routes that can
 * render a "create your first workspace" empty state.
 */
export async function getWorkspaceId(): Promise<string | null> {
  const { orgId } = await auth();
  return orgId ?? null;
}
