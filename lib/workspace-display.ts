import { clerkClient } from "@clerk/nextjs/server";
import { cache } from "react";

export type WorkspaceDisplay = {
  workspaceId: string;
  name: string;          // best display name for the workspace's owner
  email: string | null;  // owner's primary email; used as tooltip
};

// IMPORTANT: these resolvers call clerkClient(), which reads the request's
// auth context (headers/cookies). They therefore CANNOT be wrapped in
// next/cache's unstable_cache — that runs its callback outside the request
// scope and Next throws "Route used 'headers' inside a function cached with
// unstable_cache". (That was the cause of the intermittent bookmarks-page
// crash: warm cache hid it for some users, cold cache threw for others.)
//
// We use React cache() instead: request-scoped memoization that's allowed
// to touch request data. It dedupes repeated lookups within a single render
// (e.g. the same owner across tab + pending list) but not across requests —
// an acceptable trade vs. crashing.

/**
 * Resolve ONE workspace_id (a Clerk USER id — workspace_id == user id) into a
 * display record: the owner's name + primary email, for the "Shared by …" chip.
 */
const resolveOne = cache(
  async (workspaceId: string): Promise<WorkspaceDisplay> => {
    try {
      const client = await clerkClient();
      const user = await client.users.getUser(workspaceId);
      const email =
        user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
          ?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? null;
      const full =
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        user.fullName ||
        null;
      const name = full || (email ? email.split("@")[0] : "Shared library");
      return { workspaceId, name, email };
    } catch {
      // The owner user could've been deleted — fall back to a neutral label.
      return { workspaceId, name: "Shared library", email: null };
    }
  },
);

/**
 * Batch wrapper: resolve a set of workspace ids into display records.
 * Each underlying lookup is request-deduped (see resolveOne).
 */
export async function resolveWorkspaceDisplays(
  workspaceIds: string[],
): Promise<Map<string, WorkspaceDisplay>> {
  const out = new Map<string, WorkspaceDisplay>();
  if (workspaceIds.length === 0) return out;
  const unique = Array.from(new Set(workspaceIds));
  const results = await Promise.all(unique.map((id) => resolveOne(id)));
  for (const r of results) out.set(r.workspaceId, r);
  return out;
}

/**
 * Resolve ONE Clerk user id into a display name for the "Added by …"
 * attribution chip on shared-library cards. Falls back to an id prefix
 * when Clerk can't resolve.
 */
const resolveUserName = cache(async (userId: string): Promise<string> => {
  try {
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    return (
      [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
      u.fullName ||
      u.emailAddresses?.[0]?.emailAddress?.split("@")[0] ||
      userId.slice(0, 8)
    );
  } catch {
    return userId.slice(0, 8);
  }
});

/** Batch wrapper for resolveUserName. */
export async function resolveUserNames(
  userIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return out;
  const names = await Promise.all(unique.map((id) => resolveUserName(id)));
  unique.forEach((id, i) => out.set(id, names[i]));
  return out;
}
