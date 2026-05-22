import { clerkClient } from "@clerk/nextjs/server";

export type WorkspaceDisplay = {
  workspaceId: string;
  name: string;          // best display name for the workspace's owner
  email: string | null;  // owner's primary email; used as tooltip
};

/**
 * Resolve a workspace_id (Clerk org_id) into a human-friendly display
 * record for the owner. Used to label shared-library tabs without
 * splashing the recipient's email across the UI.
 *
 * Strategy: every user gets a personal org at signup (see dashboard/
 * layout.tsx), so the org's creator is the owner. We pull the org,
 * find its creator, and prefer first+last name, then full_name, then
 * email's local-part. Falls back to "Shared library" if anything is
 * missing.
 *
 * Best-effort: failure to resolve a single org doesn't blow up the
 * whole batch. Failures return a minimal record with the workspace id
 * as the name (visible enough that you'll notice, doesn't crash).
 */
export async function resolveWorkspaceDisplays(
  workspaceIds: string[],
): Promise<Map<string, WorkspaceDisplay>> {
  const out = new Map<string, WorkspaceDisplay>();
  if (workspaceIds.length === 0) return out;

  const client = await clerkClient();
  // Clerk's getOrganization doesn't batch, so we fan out and tolerate
  // individual failures. With a handful of shares this is fine; if it
  // grows past ~20 we'll want to cache.
  const settled = await Promise.allSettled(
    workspaceIds.map(async (id) => {
      const org = await client.organizations.getOrganization({ organizationId: id });
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
      return { workspaceId: id, name: displayName, email };
    }),
  );
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const wsid = workspaceIds[i];
    if (r.status === "fulfilled") {
      out.set(wsid, r.value);
    } else {
      out.set(wsid, { workspaceId: wsid, name: "Shared library", email: null });
    }
  }
  return out;
}
