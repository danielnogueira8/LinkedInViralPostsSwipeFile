import { expect, test } from "@playwright/test";

test("Your Agent keeps a visible seven-day cadence", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/dashboard/agent");

  const agentLink = page.getByRole("link", { name: /Your Agent/i });
  await expect(agentLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Your Agent" })).toBeVisible();

  await expect(page.getByTestId("weekly-cadence")).toBeVisible();
  const cards = page.getByTestId("weekly-cadence-card");
  await expect(cards).toHaveCount(7);
  await expect(page.getByText("This week's cadence")).toBeVisible();
  await page.screenshot({
    path: "/tmp/swipein-weekly-cadence.png",
    fullPage: true,
  });

  const chooseDirection = page.getByRole("button", {
    name: "Choose direction",
  });
  await expect(chooseDirection.first()).toBeVisible();
  await chooseDirection.first().click();
  const directionPanel = page.getByRole("dialog");
  await expect(
    directionPanel.getByRole("heading", { name: "Choose direction" }),
  ).toBeVisible();
  await expect(directionPanel).toHaveCSS("opacity", "1");
  await expect(directionPanel).toHaveCSS(
    "background-color",
    "lab(100 0 0)",
  );
  await expect(page.getByLabel("What should this post say?")).toBeVisible();
  await page.screenshot({
    path: "/tmp/swipein-weekly-direction-panel.png",
    fullPage: true,
  });
});

test("modeled cadence posts use their source and lead magnets ask only for a resource", async ({
  page,
}) => {
  await page.route("**/api/agent/week-plan", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        gapNote: null,
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            day: "Mon",
            date: "2026-07-20",
            kind: "opportunity",
            prompt: null,
            userContext: null,
            selectedLeadMagnetId: null,
            status: "planned",
            opportunity: {
              id: "source-regular",
              headline: "Source-modeled regular post",
              is_lead_magnet: false,
              author_avatar: null,
            },
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            day: "Tue",
            date: "2026-07-21",
            kind: "opportunity",
            prompt: null,
            userContext: null,
            selectedLeadMagnetId: null,
            status: "planned",
            opportunity: {
              id: "source-lead-magnet",
              headline: "Source-modeled lead magnet",
              is_lead_magnet: true,
              author_avatar: null,
            },
          },
          ...["Wed", "Thu", "Fri", "Sat", "Sun"].map((day, index) => ({
            id: `33333333-3333-4333-8333-33333333333${index}`,
            day,
            date: `2026-07-${22 + index}`,
            kind: "generic",
            prompt: `Share a real story ${index + 1}`,
            userContext: null,
            selectedLeadMagnetId: null,
            status: "planned",
          })),
        ],
      }),
    });
  });
  await page.goto("/dashboard/agent");

  const regularCard = page
    .getByTestId("weekly-cadence-card")
    .filter({ hasText: "Source-modeled regular post" });
  await expect(regularCard.getByText("Source ready")).toBeVisible();
  await expect(
    regularCard.getByRole("button", { name: "Draft this" }),
  ).toBeVisible();
  await expect(
    regularCard.getByRole("button", { name: /direction/i }),
  ).toHaveCount(0);

  const leadMagnetCard = page
    .getByTestId("weekly-cadence-card")
    .filter({ hasText: "Source-modeled lead magnet" });
  await leadMagnetCard
    .getByRole("button", { name: "Choose resource" })
    .click();

  const resourcePanel = page.getByRole("dialog");
  await expect(
    resourcePanel.getByRole("heading", { name: "Choose resource" }),
  ).toBeVisible();
  await expect(
    resourcePanel.getByLabel("Resource to promote"),
  ).toBeVisible();
  await expect(
    resourcePanel.getByLabel("What should this post say?"),
  ).toHaveCount(0);
});

test("Your Agent is a standalone primary destination on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard/agent");

  const agentLink = page.getByRole("link", { name: /Your Agent/i });
  await expect(agentLink).toBeVisible();
  await expect(agentLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Your Agent" })).toBeVisible();
  await expect(page.getByTestId("weekly-cadence")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open chat history" })).toHaveCount(
    0,
  );

  await page.getByRole("link", { name: "New session" }).click();
  await expect(page).toHaveURL(/\/dashboard\?new=1$/);
});
