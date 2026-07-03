import type { Page, TestInfo } from "@playwright/test";

const IGNORED_CONSOLE_ERROR_PATTERNS = [
  /favicon\.ico/i,
  /ResizeObserver loop completed/i,
];

export function failOnConsoleErrors(page: Page, testInfo: TestInfo) {
  const failures: string[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (IGNORED_CONSOLE_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
      return;
    }
    failures.push(`console.error: ${text}`);
  });

  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
  });

  return {
    async assertNoErrors() {
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
