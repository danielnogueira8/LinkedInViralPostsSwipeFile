import { expect, test } from "@playwright/test";

test("swipe filters expose stable accessible names", async ({ page }) => {
  await page.goto("/dashboard/swipe");

  await expect(page.getByRole("combobox", { name: "Sort posts" })).toBeVisible();
  await page.getByRole("button", { name: "More filters" }).click();
  await expect(page.getByRole("combobox", { name: "Filter by post type" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Minimum likes" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Minimum comments" })).toBeVisible();
});

test("category selection is assumed immediately while results load", async ({ page }) => {
  await page.goto("/dashboard/swipe");

  // Hold the category RSC response long enough to prove the chip responds to
  // the click itself rather than waiting for the server navigation to finish.
  await page.route(/\/dashboard\/swipe\?category=ai(?:&|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });

  const aiCategory = page.getByRole("link", { name: "AI/Tech", exact: true });
  await aiCategory.click();

  await expect(aiCategory).toHaveAttribute("aria-current", "page", {
    timeout: 400,
  });
  await expect(aiCategory).toHaveAttribute("aria-busy", "true");
  await expect(page).toHaveURL(/category=ai/);
});
