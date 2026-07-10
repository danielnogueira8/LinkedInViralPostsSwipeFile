import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile More menu follows the modal keyboard contract", async ({ page }) => {
  await page.goto("/dashboard/swipe");

  const moreButton = page.locator('nav[aria-label="Primary"] button[aria-haspopup="dialog"]');
  await moreButton.click();

  const dialog = page.getByRole("dialog", { name: "More navigation" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(":focus")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(moreButton).toBeFocused();
});
