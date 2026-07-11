import { clerkClient } from "@clerk/nextjs/server";

export type WorkspaceMembership = {
  organization: { id: string; createdBy?: string | null };
};

export class PersonalWorkspaceSetupError extends Error {
  constructor(message: string, public readonly reason: "missing" | "ambiguous") {
    super(message);
    this.name = "PersonalWorkspaceSetupError";
  }
}

export function selectCanonicalPersonalWorkspace(
  userId: string,
  memberships: WorkspaceMembership[],
): string {
  const owned = memberships.filter((m) => m.organization.createdBy === userId);
  if (owned.length === 1) return owned[0].organization.id;
  if (owned.length === 0) {
    throw new PersonalWorkspaceSetupError(
      "Your personal account has not been created yet. Please sign out and back in, or contact support.",
      "missing",
    );
  }
  throw new PersonalWorkspaceSetupError(
    "Your account has more than one personal workspace. Contact support so we can safely reconnect your existing data.",
    "ambiguous",
  );
}

export async function resolvePersonalWorkspaceForUser(userId: string): Promise<string> {
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId,
    limit: 100,
  });
  return selectCanonicalPersonalWorkspace(userId, memberships.data);
}
