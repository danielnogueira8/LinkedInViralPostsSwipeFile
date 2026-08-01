import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const routeSource = readFileSync(
  "app/api/agent/opportunities/[id]/route.ts",
  "utf8",
);

describe("agent opportunity action transitions", () => {
  test("dismiss only wins while the opportunity is still proposed", () => {
    const branch = routeSource.slice(
      routeSource.indexOf('if (action === "dismiss")'),
      routeSource.indexOf('if (action === "snooze")'),
    );
    expect(branch).toContain("updateManagedOpportunityStatus");
    expect(branch).toContain('"proposed"');
    expect(branch).toContain("if (!dismissed)");
  });

  test("snooze checks the affected row before reporting success", () => {
    const snoozeStart = routeSource.indexOf('if (action === "snooze")');
    const statusCheck = 'if (opportunity.status !== "proposed")';
    const firstStatusCheck = routeSource.indexOf(statusCheck, snoozeStart);
    const branch = routeSource.slice(
      snoozeStart,
      routeSource.indexOf(statusCheck, firstStatusCheck + statusCheck.length),
    );
    expect(branch).toContain("updateManagedOpportunityStatus");
    expect(branch).toContain('"proposed"');
    expect(branch).toContain("if (!snoozed)");
  });
});
