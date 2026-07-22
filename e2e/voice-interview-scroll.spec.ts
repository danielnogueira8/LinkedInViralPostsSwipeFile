import { test, expect, type Page } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

async function openInterviewQuestions(page: Page) {
  const editAnswers = page.getByRole("button", { name: /edit answers|answer questions/i });
  if (await editAnswers.isVisible()) await editAnswers.click();
}

test.describe("voice interview questions", () => {
  let consoleGuard: ReturnType<typeof failOnConsoleErrors>;

  test.beforeEach(async ({ page }, testInfo) => {
    consoleGuard = failOnConsoleErrors(page, testInfo);
    await page.goto("/dashboard/voice");
    await expect(page.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();

    await openInterviewQuestions(page);
  });

  test.afterEach(async () => {
    await consoleGuard.assertNoErrors();
  });

  test("long question lists scroll without moving the interview actions", async ({ page }) => {
    const questions = page.getByTestId("interview-questions-scroll");
    await expect(questions).toBeVisible();

    const metrics = await questions.evaluate((element) => ({
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
    }));
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    const submit = page.getByRole("button", { name: /build my context|rebuild from answers/i });
    const before = await submit.boundingBox();
    await questions.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect.poll(() => questions.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await submit.boundingBox()).toEqual(before);
  });

  test("uses page scrolling instead of a nested question scroller on small screens", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();

    await openInterviewQuestions(page);

    const questions = page.getByTestId("interview-questions-scroll");
    await expect(questions).toBeVisible();
    expect(await questions.evaluate((element) => getComputedStyle(element).overflowY)).toBe(
      "visible",
    );
  });
});
