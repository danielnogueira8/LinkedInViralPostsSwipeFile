import { describe, expect, test } from "vitest";

import { classifyPersonalWorkspaces } from "@/scripts/personal-workspace-audit-lib.mjs";

describe("personal workspace audit classification", () => {
  test("classifies every requested user and organization anomaly", () => {
    const result = classifyPersonalWorkspaces({
      users: [
        { id: "user_zero", membershipOrganizationIds: [] },
        { id: "user_one", membershipOrganizationIds: ["org_one"] },
        { id: "user_many", membershipOrganizationIds: ["org_three", "org_two"] },
      ],
      organizations: [
        { id: "org_one", createdBy: "user_one", membersCount: 1 },
        { id: "org_two", createdBy: "user_many", membersCount: 2 },
        { id: "org_three", createdBy: "user_many", membersCount: 1 },
        { id: "org_orphan", createdBy: null, membersCount: 3 },
      ],
    });

    expect(result.summary).toEqual({
      totalUsers: 3,
      totalOrganizations: 4,
      usersWithZeroMemberships: 1,
      usersWithMultipleMemberships: 1,
      usersWithMultipleCreatedOrganizations: 1,
      organizationsWithMultipleMembers: 2,
      organizationsWithoutCreator: 1,
    });
    expect(result.details.usersWithZeroMemberships).toEqual([
      { userId: "user_zero", membershipCount: 0, organizationIds: [] },
    ]);
    expect(result.details.usersWithMultipleMemberships).toEqual([
      {
        userId: "user_many",
        membershipCount: 2,
        organizationIds: ["org_three", "org_two"],
      },
    ]);
    expect(result.details.usersWithMultipleCreatedOrganizations).toEqual([
      {
        userId: "user_many",
        createdOrganizationCount: 2,
        organizationIds: ["org_three", "org_two"],
      },
    ]);
    expect(result.details.organizationsWithMultipleMembers).toEqual([
      { organizationId: "org_orphan", membersCount: 3, createdBy: null },
      { organizationId: "org_two", membersCount: 2, createdBy: "user_many" },
    ]);
    expect(result.details.organizationsWithoutCreator).toEqual([
      { organizationId: "org_orphan", membersCount: 3 },
    ]);
  });

  test("deduplicates membership organization IDs and excludes exact boundaries", () => {
    const result = classifyPersonalWorkspaces({
      users: [{ id: "user_one", membershipOrganizationIds: ["org_one", "org_one"] }],
      organizations: [{ id: "org_one", createdBy: "user_one", membersCount: 1 }],
    });

    expect(result.summary.usersWithZeroMemberships).toBe(0);
    expect(result.summary.usersWithMultipleMemberships).toBe(0);
    expect(result.summary.usersWithMultipleCreatedOrganizations).toBe(0);
    expect(result.summary.organizationsWithMultipleMembers).toBe(0);
    expect(result.summary.organizationsWithoutCreator).toBe(0);
  });
});
