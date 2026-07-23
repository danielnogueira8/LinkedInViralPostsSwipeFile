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

  await cards.first().getByRole("button", { name: "Choose direction" }).click();
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
