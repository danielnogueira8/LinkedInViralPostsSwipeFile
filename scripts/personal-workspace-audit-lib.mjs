/**
 * Classify Clerk users and organizations without performing any I/O.
 *
 * @param {{
 *   users: Array<{ id: string, membershipOrganizationIds: string[] }>,
 *   organizations: Array<{ id: string, createdBy: string | null, membersCount: number }>,
 * }} input
 */
export function classifyPersonalWorkspaces({ users, organizations }) {
  const usersWithZeroMemberships = [];
  const usersWithMultipleMemberships = [];
  const createdOrganizationsByUser = new Map();
  const organizationsWithMultipleMembers = [];
  const organizationsWithoutCreator = [];

  for (const user of users) {
    const membershipOrganizationIds = [...new Set(user.membershipOrganizationIds)].sort();
    const detail = {
      userId: user.id,
      membershipCount: membershipOrganizationIds.length,
      organizationIds: membershipOrganizationIds,
    };

    if (membershipOrganizationIds.length === 0) usersWithZeroMemberships.push(detail);
    if (membershipOrganizationIds.length > 1) usersWithMultipleMemberships.push(detail);
  }

  for (const organization of organizations) {
    if (organization.createdBy) {
      const organizationIds = createdOrganizationsByUser.get(organization.createdBy) ?? [];
      organizationIds.push(organization.id);
      createdOrganizationsByUser.set(organization.createdBy, organizationIds);
    } else {
      organizationsWithoutCreator.push({
        organizationId: organization.id,
        membersCount: organization.membersCount,
      });
    }

    if (organization.membersCount > 1) {
      organizationsWithMultipleMembers.push({
        organizationId: organization.id,
        membersCount: organization.membersCount,
        createdBy: organization.createdBy,
      });
    }
  }

  const usersWithMultipleCreatedOrganizations = [...createdOrganizationsByUser.entries()]
    .filter(([, organizationIds]) => organizationIds.length > 1)
    .map(([userId, organizationIds]) => ({
      userId,
      createdOrganizationCount: organizationIds.length,
      organizationIds: organizationIds.sort(),
    }));

  const byId = (left, right) => {
    const leftId = left.userId ?? left.organizationId;
    const rightId = right.userId ?? right.organizationId;
    return leftId.localeCompare(rightId);
  };

  const details = {
    usersWithZeroMemberships: usersWithZeroMemberships.sort(byId),
    usersWithMultipleMemberships: usersWithMultipleMemberships.sort(byId),
    usersWithMultipleCreatedOrganizations: usersWithMultipleCreatedOrganizations.sort(byId),
    organizationsWithMultipleMembers: organizationsWithMultipleMembers.sort(byId),
    organizationsWithoutCreator: organizationsWithoutCreator.sort(byId),
  };

  return {
    summary: {
      totalUsers: users.length,
      totalOrganizations: organizations.length,
      usersWithZeroMemberships: details.usersWithZeroMemberships.length,
      usersWithMultipleMemberships: details.usersWithMultipleMemberships.length,
      usersWithMultipleCreatedOrganizations: details.usersWithMultipleCreatedOrganizations.length,
      organizationsWithMultipleMembers: details.organizationsWithMultipleMembers.length,
      organizationsWithoutCreator: details.organizationsWithoutCreator.length,
    },
    details,
  };
}
