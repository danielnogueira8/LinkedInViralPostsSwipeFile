import { expect, test, type Page } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

type DocumentPresentation = {
  bodyStyle: string;
  htmlStyle: string;
  scrollX: number;
  scrollY: number;
};

function readDocumentPresentation(page: Page) {
  return page.evaluate<DocumentPresentation>(() => ({
    bodyStyle: document.body.getAttribute("style") ?? "",
    htmlStyle: document.documentElement.getAttribute("style") ?? "",
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }));
}

async function observeDocumentPresentationMutations(page: Page) {
  await page.evaluate(() => {
    const mutations: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        mutations.push(
          `${(record.target as Element).tagName}.${record.attributeName}`,
        );
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["style"],
    });
    Object.assign(window, {
      __dialogPresentationMutations: mutations,
      __dialogPresentationObserver: observer,
    });
  });
}

function readAndStopDocumentPresentationObserver(page: Page) {
  return page.evaluate(() => {
    const state = window as unknown as Window & {
      __dialogPresentationMutations: string[];
      __dialogPresentationObserver: MutationObserver;
    };
    state.__dialogPresentationObserver.disconnect();
    return state.__dialogPresentationMutations;
  });
}

test.describe("dialog close stability", () => {
  let consoleGuard: ReturnType<typeof failOnConsoleErrors>;

  test.beforeEach(async ({ page }, testInfo) => {
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("https://media.licdn.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: pixel }),
    );
    await page.route("**/_next/image?**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: pixel }),
    );
    consoleGuard = failOnConsoleErrors(page, testInfo);
  });

  test.afterEach(async () => {
    await consoleGuard.assertNoErrors();
  });

  test("desktop close never flashes the backdrop back in after it fades out", async ({ page }) => {
    await page.goto("/dashboard/accounts");
    await expect(page.getByRole("heading", { name: /^creators$/i })).toBeVisible();

    await page.getByRole("button", { name: /add creator/i }).click();
    const dialog = page.getByRole("dialog", { name: "Add creator" });
    const backdrop = page.locator('[data-slot="dialog-overlay"]');
    await expect(dialog).toBeVisible();
    await expect(backdrop).toBeVisible();

    const capture = page.evaluate(
      () =>
        new Promise<Array<{ closed: boolean; opacity: number | null; t: number }>>(
          (resolve) => {
            const frames: Array<{
              closed: boolean;
              opacity: number | null;
              t: number;
            }> = [];
            const start = performance.now();
            const sample = () => {
              const element = document.querySelector<HTMLElement>(
                '[data-slot="dialog-overlay"]',
              );
              frames.push({
                closed: Boolean(element?.hasAttribute("data-closed")),
                opacity: element
                  ? Number.parseFloat(getComputedStyle(element).opacity)
                  : null,
                t: performance.now() - start,
              });
              if (performance.now() - start >= 300) resolve(frames);
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          },
        ),
    );

    // Let the sampler observe the stable open state before triggering close.
    await page.waitForTimeout(25);
    await page.keyboard.press("Escape");
    const closedFrames = (await capture).filter(
      (frame) => frame.closed && frame.opacity !== null,
    );
    const fadedFrameIndex = closedFrames.findIndex(
      (frame) => frame.opacity! < 0.05,
    );

    expect(fadedFrameIndex).toBeGreaterThanOrEqual(0);
    expect(
      Math.max(
        ...closedFrames
          .slice(fadedFrameIndex)
          .map((frame) => frame.opacity!),
      ),
    ).toBeLessThan(0.1);
    await expect(dialog).toBeHidden();
    await expect(backdrop).toHaveCount(0);
  });

  test("ordinary desktop dialogs do not mutate the page presentation", async ({ page }) => {
    await page.goto("/dashboard/accounts");
    await expect(page.getByRole("heading", { name: /^creators$/i })).toBeVisible();

    const beforeOpen = await readDocumentPresentation(page);
    await observeDocumentPresentationMutations(page);

    await page.getByRole("button", { name: /add creator/i }).click();
    const dialog = page.getByRole("dialog", { name: "Add creator" });
    await expect(dialog).toBeVisible();

    await expect.poll(() => readDocumentPresentation(page)).toEqual(beforeOpen);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(() => readDocumentPresentation(page)).toEqual(beforeOpen);
    expect(await readAndStopDocumentPresentationObserver(page)).toEqual([]);
  });

  test("ordinary mobile dialogs do not mutate or scroll the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard/swipe");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    const imagePreview = page.locator('button[title="Click to view full image"]').first();
    await expect(imagePreview).toBeVisible();
    await imagePreview.scrollIntoViewIfNeeded();
    const beforeOpen = await readDocumentPresentation(page);
    expect(beforeOpen.scrollY).toBeGreaterThan(0);
    await observeDocumentPresentationMutations(page);

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: /more/i })
      .click();
    const dialog = page.getByRole("dialog", { name: "More navigation" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    await expect.poll(() => readDocumentPresentation(page)).toEqual(beforeOpen);

    await page.mouse.move(195, 422);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => readDocumentPresentation(page)).toEqual(beforeOpen);

    await page.keyboard.press("PageDown");
    await expect.poll(() => readDocumentPresentation(page)).toEqual(beforeOpen);

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    const x = Math.round(dialogBox!.x + dialogBox!.width / 2);
    const startY = Math.round(dialogBox!.y + dialogBox!.height * 0.75);
    const endY = Math.round(dialogBox!.y + dialogBox!.height * 0.25);
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
    await expect.poll(() => readDocumentPresentation(page)).toEqual(beforeOpen);

    await dialog.evaluate((element) => {
      const filler = document.createElement("div");
      filler.setAttribute("data-testid", "dialog-scroll-filler");
      filler.style.height = "1200px";
      filler.style.flex = "0 0 1200px";
      element.append(filler);
      element.scrollTop = 0;
    });
    await page.mouse.move(x, Math.round(dialogBox!.y + dialogBox!.height / 2));
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect.poll(() => readDocumentPresentation(page)).toEqual(beforeOpen);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(() => readDocumentPresentation(page)).toEqual(beforeOpen);
    expect(await readAndStopDocumentPresentationObserver(page)).toEqual([]);
  });
});
