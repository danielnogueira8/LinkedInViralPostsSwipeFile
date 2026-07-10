import { expect, test } from "@playwright/test";

test("swipe filters expose stable accessible names", async ({ page }) => {
  await page.goto("/dashboard/swipe");

  await expect(page.getByRole("combobox", { name: "Sort posts" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Filter by post type" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Minimum likes" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Minimum comments" })).toBeVisible();
});
