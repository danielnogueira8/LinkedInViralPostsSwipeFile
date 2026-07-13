import type { Page, TestInfo } from "@playwright/test";

const IGNORED_CONSOLE_ERROR_PATTERNS = [
  /favicon\.ico/i,
  /ResizeObserver loop completed/i,
];

export function failOnConsoleErrors(page: Page, testInfo: TestInfo) {
  const failures: string[] = [];
  const expectedConsoleErrors: RegExp[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (expectedConsoleErrors.some((pattern) => pattern.test(text))) return;
    if (IGNORED_CONSOLE_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
      return;
    }
    failures.push(`console.error: ${text}`);
  });

  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
  });

  return {
    allowConsoleError(pattern: RegExp) {
      expectedConsoleErrors.push(pattern);
    },
    async assertNoErrors() {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const mainVisible = await page
        .locator("main, [role=main]")
        .first()
        .isVisible()
        .catch(() => false);
      if (!bodyText.trim() || !mainVisible) {
        failures.push("blank-state: authenticated app body/main did not render");
      }
      if (failures.length > 0) {
        await testInfo.attach("console-errors", {
          contentType: "text/plain",
          body: failures.join("\n"),
        });
        throw new Error(failures.join("\n"));
      }
    },
  };
}
