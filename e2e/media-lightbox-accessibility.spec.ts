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
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("opening and closing a media dialog preserves the feed scroll geometry", async ({ page }) => {
    await page.goto("/dashboard/swipe");

    const imagePreviews = page.locator('button[title="Click to view full image"]');
    await expect(imagePreviews.first()).toBeVisible();
    await imagePreviews.first().scrollIntoViewIfNeeded();
    const feedScroller = page.locator('[data-slot="dashboard-scroll-container"]');
    await expect(feedScroller).toBeVisible();
    await feedScroller.evaluate((element) => {
      element.scrollTop = Math.min(900, element.scrollHeight - element.clientHeight);
    });

    const readPageGeometry = () =>
      feedScroller.evaluate((element) => ({
        bodyOverflow: getComputedStyle(document.body).overflow,
        feedScrollTop: element.scrollTop,
      }));

    const beforeOpen = await readPageGeometry();
    expect(beforeOpen.feedScrollTop).toBe(900);

    await imagePreviews.first().click();

    const overlay = page.locator('[data-slot="dialog-overlay"]');
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveCSS("backdrop-filter", "none");

    await expect.poll(readPageGeometry).toEqual(beforeOpen);

    await overlay.click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole("dialog", { name: "Image preview" })).toBeHidden();
    await expect.poll(readPageGeometry).toEqual(beforeOpen);
  });

  test("media dialogs block background scrolling on a mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard/swipe");

    const imagePreview = page.locator('button[title="Click to view full image"]').first();
    await expect(imagePreview).toBeVisible();
    await imagePreview.scrollIntoViewIfNeeded();

    const readViewportPosition = () =>
      page.evaluate(() => ({
        bodyOverflow: getComputedStyle(document.body).overflow,
        scrollY: window.scrollY,
      }));
    const beforeOpen = await readViewportPosition();
    expect(beforeOpen.scrollY).toBeGreaterThan(0);

    await imagePreview.click();
    const dialog = page.getByRole("dialog", { name: "Image preview" });
    await expect(dialog).toBeVisible();
    await expect.poll(readViewportPosition).toEqual(beforeOpen);

    await page.mouse.move(195, 422);
    await page.mouse.wheel(0, 500);
    await expect.poll(readViewportPosition).toEqual(beforeOpen);

    await page.keyboard.press("ArrowDown");
    await expect.poll(readViewportPosition).toEqual(beforeOpen);

    await page.keyboard.press("PageDown");
    await expect.poll(readViewportPosition).toEqual(beforeOpen);

    const x = 195;
    const startY = 520;
    const endY = 340;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: startY }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: endY }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();

    await expect.poll(readViewportPosition).toEqual(beforeOpen);
  });
});
