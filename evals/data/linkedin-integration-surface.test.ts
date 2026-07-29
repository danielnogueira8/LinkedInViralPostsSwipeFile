import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const settingsPage = readFileSync(
  new URL("../../app/(app)/dashboard/settings/page.tsx", import.meta.url),
  "utf8",
);
const integrationsPage = readFileSync(
  new URL("../../app/(app)/dashboard/integrations/page.tsx", import.meta.url),
  "utf8",
);

describe("LinkedIn connection surface", () => {
  test("is owned by Integrations instead of Settings", () => {
    expect(integrationsPage).toContain("<LinkedInPublishingCard");
    expect(settingsPage).not.toContain("LinkedInPublishingCard");
    expect(settingsPage).toContain(
      'description="Tune discovery thresholds and workspace-level account controls."',
    );
  });
});
