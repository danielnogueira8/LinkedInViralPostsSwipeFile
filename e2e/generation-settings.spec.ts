import { expect, test, type Page } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

test.describe("composer generation settings", () => {
  const chatsToDelete: string[] = [];
  let consoleGuard: ReturnType<typeof failOnConsoleErrors>;

  test.beforeEach(async ({ page }, testInfo) => {
    consoleGuard = failOnConsoleErrors(page, testInfo);
  });

  test.afterEach(async ({ page }) => {
    const failures: string[] = [];
    for (const id of chatsToDelete.splice(0)) {
      try {
        const status = await page.evaluate(async (chatId) => {
          const response = await fetch(`/api/chats/${chatId}`, {
            method: "DELETE",
          });
          return response.status;
        }, id);
        if (status >= 300) failures.push(`chat ${id}: delete ${status}`);
      } catch (error) {
        failures.push(`chat ${id}: ${(error as Error).message}`);
      }
    }
    try {
      await consoleGuard.assertNoErrors();
    } catch (error) {
      failures.push((error as Error).message);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  });

  test("selects an exact count, sends the versioned contract, and can return to Auto", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const chatId = await createChat(page);
    chatsToDelete.push(chatId);

    const streamBodies: Array<Record<string, unknown>> = [];
    await page.route(`**/api/chats/${chatId}/stream`, async (route) => {
      streamBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse("done", { artifacts: [] }),
      });
    });

    await page.goto(`/dashboard?chat=${chatId}`);
    const composer = page.getByPlaceholder("What do you want to write?");
    await expect(composer).toBeVisible();

    const autoButton = page.getByRole("button", { name: "Draft count: Auto" });
    await expect(autoButton).toHaveAttribute("aria-expanded", "false");
    await autoButton.click();

    const dialog = page.getByRole("dialog", { name: "Generation settings" });
    await expect(dialog).toBeVisible();
    const draftGroup = dialog.getByRole("group", { name: "Number of drafts" });
    await expect(
      draftGroup.getByRole("button", { name: "Auto", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await draftGroup.getByRole("button", { name: "3", exact: true }).click();

    const exactButton = page.getByRole("button", { name: "Draft count: 3" });
    await expect(exactButton).toBeVisible();
    await composer.fill("Write original LinkedIn posts about content systems.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => streamBodies.length).toBe(1);
    expect(streamBodies[0]).toMatchObject({
      message: "Write original LinkedIn posts about content systems.",
      generationConfig: { version: 1, draftCount: 3 },
    });
    await expect(exactButton).toBeVisible();

    await exactButton.click();
    const resetDialog = page.getByRole("dialog", {
      name: "Generation settings",
    });
    await resetDialog
      .getByRole("group", { name: "Number of drafts" })
      .getByRole("button", { name: "Auto", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Draft count: Auto" }),
    ).toBeVisible();

    await composer.fill("Write an original LinkedIn post about content systems.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => streamBodies.length).toBe(2);
    expect(streamBodies[1]).not.toHaveProperty("generationConfig");
  });
});

async function createChat(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `Generation settings E2E ${Date.now()}` }),
    });
    const payload = await response.json();
    if (!payload.ok || !payload.chat?.id) {
      throw new Error(payload.error || "Failed to create generation-settings chat");
    }
    return payload.chat.id as string;
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
