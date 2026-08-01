import { expect, test } from "@playwright/test";

const idea = (
  lane:
    | "newsjacking"
    | "personal_story"
    | "educational"
    | "trend_radar",
  index: number,
) => ({
  id: `idea-${index}`,
  workspaceId: "test-workspace",
  lane,
  ...(lane === "trend_radar" ? { radar: true } : {}),
  status: "active",
  readAt: null,
  headline:
    lane === "newsjacking"
      ? "A timely AI shift"
      : lane === "personal_story"
        ? "The hard-won lesson behind a client turnaround"
        : lane === "educational"
          ? "Turn your strongest topic into a practical teardown"
          : "A conversation your audience can join early",
  angle: "A specific direction grounded in the evidence attached to this card.",
  why: [
    "It matches an active audience concern",
    "It gives the user a concrete point of view",
  ],
  evidence: [
    {
      kind:
        lane === "newsjacking" || lane === "trend_radar"
          ? "news"
          : lane === "educational"
            ? "performance"
            : "knowledge",
      label:
        lane === "newsjacking" || lane === "trend_radar"
          ? "Verified industry update"
          : "Workspace evidence",
      detail: "Evidence detail",
      url:
        lane === "newsjacking" || lane === "trend_radar"
          ? "https://example.com/news"
          : null,
      publishedAt:
        lane === "newsjacking" || lane === "trend_radar"
          ? new Date().toISOString()
          : null,
    },
  ],
  sourceKind:
    lane === "newsjacking" || lane === "trend_radar"
      ? "news"
      : lane === "educational"
        ? "workspace_learning"
        : "knowledge",
  sourceRef: `source-${index}`,
  sourceUrl:
    lane === "newsjacking" || lane === "trend_radar"
      ? "https://example.com/news"
      : null,
  sourceTitle: "Evidence",
  sourcePublishedAt:
    lane === "newsjacking" || lane === "trend_radar"
      ? new Date().toISOString()
      : null,
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
  await page.route("**/api/agent/inbox**", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        active: [idea("newsjacking", 1), idea("personal_story", 2)],
        trends: [idea("trend_radar", 3)],
        activity: [],
        trendActivity: [],
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

test("shows four equal agent filters with human approval controls", async ({
  page,
}) => {
  await page.goto("/dashboard/agent");
  for (const label of ["Newsjacking", "Story Miner", "Expertise", "Trend Radar"]) {
    await expect(
      page.getByRole("button", { name: new RegExp(label) }).first(),
    ).toBeVisible();
  }
  // The detail panel is not mounted until the user chooses a recommendation.
  await expect(page.getByRole("button", { name: "Open in Cowork" })).toHaveCount(0);
  await expect(page.getByText(/Select a recommendation/)).toHaveCount(0);
  await page
    .getByRole("button", { name: /Newsjacking: A timely AI shift/ })
    .click();
  await expect(page.getByRole("button", { name: "Open in Cowork" })).toHaveCount(1);
  await expect(
    page.getByText(/New ideas arrive every day/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Discard/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Not today|Snooze/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /schedule/i })).toHaveCount(0);
});

test("keeps the Trend Radar lane visible without an active idea", async ({
  page,
}) => {
  await page.route("**/api/agent/inbox**", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        active: [],
        activity: [],
        trends: [],
        trendActivity: [],
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

  await expect(page.getByRole("button", { name: /Trend Radar/ })).toBeVisible();
  const grid = page.locator("#agent-opportunity-grid");
  await expect(grid.getByText("New ideas arrive every day", { exact: true })).toBeVisible();
});

test("keeps the recommendation list full width before selection on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard/agent");
  const grid = page.locator("#agent-opportunity-grid");
  await expect(grid.locator(":scope > *")).toHaveCount(1);
  await expect(page.getByText(/Select a recommendation/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open in Cowork" })).toHaveCount(0);
});

test("an acted idea stays in recent activity while fresh ideas remain actionable", async ({
  page,
}) => {
  const actedIdea = {
    ...idea("personal_story", 2),
    status: "acted",
    actedAt: new Date().toISOString(),
    readAt: new Date().toISOString(),
  };
  await page.route("**/api/agent/inbox**", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        active: [idea("newsjacking", 1)],
        trends: [idea("trend_radar", 3)],
        activity: [actedIdea],
        trendActivity: [],
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
  await expect(page.getByText("Done", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/hard-won lesson behind a client turnaround/),
  ).toBeVisible();
  await expect(page.getByText("No strong fit today")).toHaveCount(0);
  await page
    .getByRole("button", { name: /Newsjacking: A timely AI shift/ })
    .click();
  // The inbox has one focused action surface after selecting an idea.
  await expect(page.getByRole("button", { name: "Open in Cowork" })).toHaveCount(1);
});
