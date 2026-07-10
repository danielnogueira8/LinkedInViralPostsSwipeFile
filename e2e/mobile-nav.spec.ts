import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile primary navigation stays on one row", async ({ page }) => {
  await page.goto("/dashboard/swipe");

  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();

  const items = nav.locator("li");
  await expect(items).toHaveCount(5);

  const topEdges = await items.evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().top)),
  );
  expect(new Set(topEdges).size).toBe(1);
});
