import { expect, test } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

test.describe("Swipe File and bookmark media", () => {
  let consoleGuard: ReturnType<typeof failOnConsoleErrors>;

  test.beforeEach(async ({ page }, testInfo) => {
    await page.route("**/_next/image?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    consoleGuard = failOnConsoleErrors(page, testInfo);
  });

  test.afterEach(async () => {
    await consoleGuard.assertNoErrors();
  });

  test("Swipe File image lightbox has a name, description, and close control", async ({ page }) => {
    await page.goto("/dashboard/swipe");

    const imagePreviews = page.locator('button[title="Click to view full image"]');
    await expect(imagePreviews.first()).toBeVisible();
    await imagePreviews.first().click();

    const dialog = page.getByRole("dialog", { name: "Image preview" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", /LinkedIn post image/);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  });

  test("bookmark image lightbox opens with a name and closes cleanly", async ({ page }) => {
    await page.goto("/dashboard/swipe?tab=bookmarks");

    const imagePreviews = page.locator('button[title="Click to view full image"]');
    await expect(imagePreviews.first()).toBeVisible();
    await imagePreviews.first().click();

    const dialog = page.getByRole("dialog", { name: "Bookmark image preview" });
    await expect(dialog).toBeVisible();
    const image = dialog.getByRole("img");
    await expect(image).toHaveAttribute("alt", /LinkedIn post image/);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
