import { expect, test } from "@playwright/test";

const idea = (lane: "now" | "proven" | "explore", index: number) => ({
  id: `idea-${index}`,
  workspaceId: "test-workspace",
  lane,
  status: "active",
  headline: `${lane === "now" ? "A timely AI shift" : lane === "proven" ? "Turn your strongest topic into a practical teardown" : "Challenge a familiar founder assumption"}`,
  angle: "A specific direction grounded in the evidence attached to this card.",
  why: [
    "It matches an active audience concern",
    "It gives the user a concrete point of view",
  ],
  evidence: [
    {
      kind:
        lane === "now"
          ? "news"
          : lane === "proven"
            ? "performance"
            : "knowledge",
      label: lane === "now" ? "Verified industry update" : "Workspace evidence",
      detail: "Evidence detail",
      url: lane === "now" ? "https://example.com/news" : null,
    },
  ],
  sourceKind:
    lane === "now"
      ? "news"
      : lane === "proven"
        ? "workspace_learning"
        : "knowledge",
  sourceRef: `source-${index}`,
  sourceUrl: lane === "now" ? "https://example.com/news" : null,
  sourceTitle: "Evidence",
  sourcePublishedAt: lane === "now" ? new Date().toISOString() : null,
  score: 0.9,
  fingerprint: `fingerprint-${index}`,
  availableOn: "2026-07-30",
  expiresAt: null,
  snoozedUntil: null,
  actedAt: null,
  discardReason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/agent/inbox", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        active: [idea("now", 1), idea("proven", 2), idea("explore", 3)],
        activity: [],
        preferences: {
          enabled: true,
          timezone: "Europe/Lisbon",
          deliveryLocalTime: "08:00",
          topics: [],
          newsSensitivity: "standard",
        },
      },
    });
  });
});

test("shows the three evidence-backed lanes without autonomous controls", async ({
  page,
}) => {
  await page.goto("/dashboard/agent");
  await expect(page.getByTestId("agent-lane-now")).toBeVisible();
  await expect(page.getByTestId("agent-lane-proven")).toBeVisible();
  await expect(page.getByTestId("agent-lane-explore")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start draft" })).toHaveCount(
    3,
  );
  await expect(
    page.getByText(/Nothing is drafted or scheduled until you choose it/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /schedule/i })).toHaveCount(0);
});

test("stacks the agent rows vertically on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard/agent");
  const now = page.getByTestId("agent-lane-now");
  const proven = page.getByTestId("agent-lane-proven");
  await expect(now).toBeVisible();
  const nowBox = await now.boundingBox();
  const provenBox = await proven.boundingBox();
  expect(nowBox?.width).toBeLessThan(390);
  // Rows (not columns): each agent's section sits BELOW the previous one.
  expect(provenBox?.y).toBeGreaterThan(nowBox?.y ?? 0);
});

test("an acted lane says the draft started instead of claiming no strong fit", async ({
  page,
}) => {
  const actedIdea = {
    ...idea("proven", 2),
    status: "acted",
    actedAt: new Date().toISOString(),
  };
  await page.route("**/api/agent/inbox", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        active: [idea("now", 1), idea("explore", 3)],
        activity: [actedIdea],
        preferences: {
          enabled: true,
          timezone: "Europe/Lisbon",
          deliveryLocalTime: "08:00",
          topics: [],
          newsSensitivity: "standard",
        },
      },
    });
  });
  await page.goto("/dashboard/agent");
  const proven = page.getByTestId("agent-lane-proven");
  await expect(proven.getByText("Draft started")).toBeVisible();
  await expect(
    proven.getByText(/Turn your strongest topic into a practical teardown/),
  ).toBeVisible();
  await expect(proven.getByText("No strong fit today")).toHaveCount(0);
  // The other two lanes still offer their ideas; the acted lane has no CTA.
  await expect(page.getByRole("button", { name: "Start draft" })).toHaveCount(
    2,
  );
});
