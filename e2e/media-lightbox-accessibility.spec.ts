import { expect, test } from "@playwright/test";

test("image lightbox has a name, content description, and close control", async ({ page }) => {
  await page.goto("/dashboard/swipe");

  const imagePreviews = page.locator('button[title="Click to view full image"]');
  test.skip((await imagePreviews.count()) === 0, "No image posts are available.");
  await imagePreviews.first().click();

  const dialog = page.getByRole("dialog", { name: "Image preview" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveAttribute("alt", /LinkedIn post image/);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
});
