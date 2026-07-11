#!/usr/bin/env node

import { classifyPersonalWorkspaces } from "./personal-workspace-audit-lib.mjs";

const PAGE_SIZE = 100;

if (!process.env.CLERK_SECRET_KEY) {
  console.error("CLERK_SECRET_KEY is required. No Clerk API requests were made.");
  process.exitCode = 1;
} else {
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

    const users = await paginate((offset) =>
      client.users.getUserList({ limit: PAGE_SIZE, offset }),
    );
    const organizations = await paginate((offset) =>
      client.organizations.getOrganizationList({ limit: PAGE_SIZE, offset }),
    );

    const usersForClassification = [];
    for (const user of users) {
      const memberships = await paginate((offset) =>
        client.users.getOrganizationMembershipList({
          userId: user.id,
          limit: PAGE_SIZE,
          offset,
        }),
      );
      usersForClassification.push({
        id: user.id,
        membershipOrganizationIds: memberships.map((membership) => membership.organization.id),
      });
    }

    const organizationsForClassification = [];
    for (const organization of organizations) {
      const memberships = await paginate((offset) =>
        client.organizations.getOrganizationMembershipList({
          organizationId: organization.id,
          limit: PAGE_SIZE,
          offset,
        }),
      );
      organizationsForClassification.push({
        id: organization.id,
        createdBy: organization.createdBy ?? null,
        membersCount: memberships.length,
      });
    }

    const report = classifyPersonalWorkspaces({
      users: usersForClassification,
      organizations: organizationsForClassification,
    });

    console.log(JSON.stringify({ auditedAt: new Date().toISOString(), ...report }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Clerk personal workspace audit failed: ${message}`);
    process.exitCode = 1;
  }
}

async function paginate(fetchPage) {
  const all = [];
  let offset = 0;

  while (true) {
    const page = await fetchPage(offset);
    all.push(...page.data);
    offset += page.data.length;

    if (page.data.length === 0 || offset >= page.totalCount) return all;
  }
}
