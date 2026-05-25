import { auth } from "@clerk/nextjs/server";
import { scopedSupabase } from "./supabase-scoped";
import { resolveWorkspaceDisplays } from "./workspace-display";

// Resolved "active library" — the bookmarks library the request is
// targeting. Either the caller's own workspace (default), or a shared
// library they've accepted an invite for.
//
// `kind`:
//   - "own"    → workspace_id matches the caller's org. Caller can
//                read/write/delete anything.
//   - "shared" → workspace_id is some other workspace's. Caller is the
//                accepted recipient. They can read everything, write
//                new saves (attributed via created_by_user_id), and
//                edit/delete only their own contributions. Override
//                rows let them re-tag owner-created saves.
export type ActiveLibrary =
  | { kind: "own"; workspaceId: string; userId: string | null }
  | {
      kind: "shared";
      // The OWNER's workspace — this is the workspace_id we read/write
      // saved_posts under. Don't confuse with the caller's own org id.
      workspaceId: string;
      shareId: string;
      // Caller's Clerk user id, always present in shared mode (we need
      // it to attribute saves and gate per-recipient edits).
      userId: string;
    };

export class SharedBookmarkAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedBookmarkAccessError";
  }
}

/**
 * Resolve which bookmarks library a request is acting on.
 *
 * If `shareId` is omitted → caller's own library. The caller MUST have
 * an active org (we surface it from `scopedSupabase`).
 *
 * If `shareId` is provided → look up the share, verify the caller is
 * the accepted recipient, return the owner's workspace as the target.
 * Throws SharedBookmarkAccessError on anything iffy.
 */
export async function resolveActiveLibrary(
  shareId: string | null,
): Promise<ActiveLibrary> {
  const sb = await scopedSupabase();
  const { userId } = await auth();
  if (!shareId) {
    return { kind: "own", workspaceId: sb.workspaceId, userId: userId ?? null };
  }
  if (!userId) {
    // Shared mode REQUIRES a known user id (the share is bound to a
    // specific Clerk user). Without it we can't authorize.
    throw new SharedBookmarkAccessError("Sign in to access shared bookmarks.");
  }
  const { data: share, error } = await sb.raw
    .from("shared_bookmarks")
    .select("id, owner_workspace_id, recipient_user_id, status")
    .eq("id", shareId)
    .maybeSingle();
  if (error || !share) {
    // Don't leak whether the share exists for another recipient — both
    // "doesn't exist" and "not yours" surface as 404.
    throw new SharedBookmarkAccessError("Share not found.");
  }
  if (share.status !== "accepted") {
    throw new SharedBookmarkAccessError("Share is not active.");
  }
  if (share.recipient_user_id !== userId) {
    throw new SharedBookmarkAccessError("Share not found.");
  }
  return {
    kind: "shared",
    workspaceId: share.owner_workspace_id as string,
    shareId: share.id as string,
    userId,
  };
}

/**
 * For a row the caller is acting on in a shared library: can they
 * mutate (delete, hard-edit) it?
 *
 * The owner of the library always can. A recipient can only mutate
 * saves they themselves added (created_by_user_id matches).
 *
 * Note: this is for hard mutations (delete, change post_url, etc.).
 * Note/category re-tagging by recipients goes through the overrides
 * table and has different semantics.
 */
export function canHardMutate(
  active: ActiveLibrary,
  row: { created_by_user_id: string | null },
): boolean {
  if (active.kind === "own") return true;
  return row.created_by_user_id === active.userId;
}

// A library the current user can SAVE into: their own, plus any shared
// library they've accepted. `shareId` is null for the own library and the
// share row id for shared ones — pass it as ?share=<id> to POST /api/saved-posts.
export type WritableLibrary = { shareId: string | null; label: string };

/**
 * List the libraries the current user can bookmark into — their own
 * ("My bookmarks") plus every accepted shared library, labeled with the
 * owner's display name. Used to populate the bookmark-from-feed picker.
 * Returns just [{ shareId: null, label: "My bookmarks" }] when the user
 * has no accepted shares.
 */
export async function listWritableLibraries(): Promise<WritableLibrary[]> {
  const sb = await scopedSupabase();
  const { userId } = await auth();
  const libs: WritableLibrary[] = [{ shareId: null, label: "My bookmarks" }];
  if (!userId) return libs;

  const { data: shares } = await sb.raw
    .from("shared_bookmarks")
    .select("id, owner_workspace_id")
    .eq("recipient_user_id", userId)
    .eq("status", "accepted");
  const rows = (shares ?? []) as Array<{ id: string; owner_workspace_id: string }>;
  if (rows.length === 0) return libs;

  const displays = await resolveWorkspaceDisplays(
    rows.map((r) => r.owner_workspace_id),
  );
  for (const r of rows) {
    const d = displays.get(r.owner_workspace_id);
    libs.push({ shareId: r.id, label: d?.name ?? "Shared library" });
  }
  return libs;
}
