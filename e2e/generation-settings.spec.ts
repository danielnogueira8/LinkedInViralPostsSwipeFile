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
    try {
      await consoleGuard.assertNoErrors();
    } catch (error) {
      failures.push((error as Error).message);
    }
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
    if (failures.length) throw new Error(failures.join("\n"));
  });

  test("sends explicit Ask/Create commands and resets every completed turn to Ask", async ({
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
    const composer = page.getByPlaceholder("Ask Cowork anything…");
    await expect(composer).toBeVisible();

    const commandGroup = page.getByRole("group", { name: "Cowork command" });
    const askButton = commandGroup.getByRole("button", { name: "Ask", exact: true });
    const createButton = commandGroup.getByRole("button", { name: "Create", exact: true });
    await expect(askButton).toHaveAttribute("aria-pressed", "true");

    await composer.fill("Write three posts even though this turn is Ask.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => streamBodies.length).toBe(1);
    expect(streamBodies[0]).toMatchObject({
      message: "Write three posts even though this turn is Ask.",
      command: { kind: "ask" },
    });
    await expect(askButton).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Add context", exact: true }).last().click();
    await page.getByRole("button", { name: "Choose post format" }).click();
    const formatDialog = page.getByRole("dialog", { name: "Choose post format" });
    await formatDialog
      .getByRole("button", { name: /Lead Magnet: System Breakdown/ })
      .click();
    await expect(createButton).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", {
        name: /Generation settings — Post count: 1, post type: Any/,
      }),
    ).toBeVisible();

    await createButton.click();
    await expect(createButton).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByPlaceholder("What should the new post be about?"),
    ).toBeVisible();

    const autoButton = page.getByRole("button", {
      name: /Generation settings — Post count: 1, post type: Any/,
    });
    await expect(autoButton).toHaveAttribute("aria-expanded", "false");
    await autoButton.click();

    const dialog = page.getByRole("dialog", { name: "Generation settings" });
    await expect(dialog).toBeVisible();
    const draftGroup = dialog.getByRole("group", { name: "Number of Posts" });
    await expect(
      draftGroup.getByRole("button", { name: "1", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await draftGroup.getByRole("button", { name: "3", exact: true }).click();

    const exactButton = page.getByRole("button", {
      name: /Generation settings — Post count: 3, post type: Any/,
    });
    await expect(exactButton).toBeVisible();
    const createComposer = page.getByPlaceholder(
      "What should the new post be about?",
    );
    await createComposer.fill("Review my current post and give feedback only.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => streamBodies.length).toBe(2);
    expect(streamBodies[1]).toMatchObject({
      message: "Review my current post and give feedback only.",
      command: { kind: "create", count: 3 },
      generationConfig: { version: 1, draftCount: 3 },
    });
    await expect(askButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByPlaceholder("Ask Cowork anything…")).toBeVisible();
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
