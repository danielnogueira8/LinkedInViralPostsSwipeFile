import { auth } from "@clerk/nextjs/server";

export class NoWorkspaceError extends Error {
  constructor() {
    super("No active workspace. Create or select a Clerk organization first.");
    this.name = "NoWorkspaceError";
  }
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
