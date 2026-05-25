import { clerkClient } from "@clerk/nextjs/server";
import { unstable_cache } from "next/cache";

export type WorkspaceDisplay = {
  workspaceId: string;
  name: string;          // best display name for the workspace's owner
  email: string | null;  // owner's primary email; used as tooltip
};

/**
 * Resolve ONE workspace_id (Clerk org_id) into a display record.
 *
 * Wrapped in unstable_cache: org/owner names change rarely, but this
 * fires on every bookmarks-page render (once per shared-library tab),
 * each one a slow Clerk org + user network hop. A 10-minute cross-
 * request cache keyed by workspace id collapses repeat loads to a
 * single hop per workspace per window.
 */
const resolveOne = unstable_cache(
  async (workspaceId: string): Promise<WorkspaceDisplay> => {
    const client = await clerkClient();
    try {
      const org = await client.organizations.getOrganization({
        organizationId: workspaceId,
      });
      let displayName: string = org.name || "Shared library";
      let email: string | null = null;
      if (org.createdBy) {
        try {
          const user = await client.users.getUser(org.createdBy);
          const full =
            [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
            user.fullName ||
            null;
          email =
            user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
              ?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? null;
          if (full) displayName = full;
          else if (email) displayName = email.split("@")[0];
        } catch {
          // Owner user could've been deleted — keep the org-name fallback.
        }
      }
      return { workspaceId, name: displayName, email };
    } catch {
      return { workspaceId, name: "Shared library", email: null };
    }
  },
  ["workspace-display"],
  { revalidate: 600 },
);

/**
 * Batch wrapper: resolve a set of workspace ids into display records.
 * Each underlying lookup is cached independently (see resolveOne), so
 * repeated tabs / repeat visits don't re-hit Clerk.
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
 * attribution chip on shared-library cards. Cached cross-request like
 * resolveOne — contributor names rarely change and the bookmarks page
 * would otherwise re-hit Clerk for the same handful of users on every
 * render. Falls back to an id prefix when Clerk can't resolve.
 */
const resolveUserName = unstable_cache(
  async (userId: string): Promise<string> => {
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
  },
  ["user-display-name"],
  { revalidate: 600 },
);

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
