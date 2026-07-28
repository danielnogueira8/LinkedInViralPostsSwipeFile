import { expect, test, type Page } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

test.describe("new board posts and LinkedIn scheduling", () => {
  const draftsToDelete: string[] = [];
  let consoleGuard: ReturnType<typeof failOnConsoleErrors>;

  test.beforeEach(async ({ page }, testInfo) => {
    consoleGuard = failOnConsoleErrors(page, testInfo);
    await page.goto("/dashboard/posts");
    await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    for (const id of draftsToDelete.splice(0)) {
      await page.evaluate((draftId) => fetch(`/api/drafts/${draftId}`, { method: "DELETE" }), id);
    }
    await consoleGuard.assertNoErrors();
  });

  test("creates an unscheduled post normally", async ({ page }) => {
    const draft = await createPost(page, "Create post");
    draftsToDelete.push(draft.id);
    expect(draft.schedule_status).toBeNull();
  });

  test("uses the first line of pasted post text as a blank new draft's title", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "New post" }).click();
    const editor = page.getByRole("dialog");
    const body = editor.locator("textarea").first();
    await body.evaluate((element) => {
      const clipboard = new DataTransfer();
      clipboard.setData(
        "text/plain",
        "A pasted hook becomes the title\n\nThe remaining post stays in the editor.",
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    });
    await expect(editor.getByLabel("Preview name")).toHaveValue(
      "A pasted hook becomes the title",
    );
  });

  test("creates and schedules a post from the board", async ({ page }) => {
    const scheduledAt = futureDatetimeLocal();
    let scheduledId = "";
    await page.route("**/api/drafts/*/schedule", async (route) => {
      scheduledId = route.request().url().split("/").at(-2) ?? "";
      const payload = route.request().postDataJSON() as { scheduledAt: string; firstComment: string | null };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          scheduledAt: payload.scheduledAt,
          planToPostOn: payload.scheduledAt.slice(0, 10),
          firstComment: payload.firstComment,
        }),
      });
    });

    await page.getByRole("button", { name: "New post" }).click();
    await page.getByLabel("Preview name").fill(`Scheduled board post ${Date.now()}`);
    await page.locator("textarea").first().fill("A scheduled post created directly from the board.");
    await page.getByLabel("Publish date and time").fill(scheduledAt);
    await page.getByRole("button", { name: "Create & schedule on LinkedIn" }).click();
    await expect(page.getByText(/Post created and scheduled/)).toBeVisible();
    expect(scheduledId).not.toBe("");
    draftsToDelete.push(scheduledId);
  });

  test("creates a post from an open queue slot and schedules it there on save", async ({ page }) => {
    consoleGuard.allowConsoleError(/Failed to load resource.*409/i);
    const queue = page.getByRole("region", { name: "Posting queue" });
    const queueToggle = queue.getByRole("button", { name: /^Posting queue/ });
    if ((await queueToggle.getAttribute("aria-expanded")) === "false") {
      await queueToggle.click();
    }

    const createForSlot = queue.getByRole("button", { name: /^Create a post for / }).first();
    await expect(createForSlot).toBeVisible();
    const slotLabel = (await createForSlot.getAttribute("aria-label"))?.replace(
      "Create a post for ",
      "",
    );
    if (!slotLabel) throw new Error("Open queue slot has no accessible label");

    let createRequests = 0;
    const updatePayloads: Array<Record<string, unknown>> = [];
    const queuedDraftIds: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/drafts") && request.method() === "POST") {
        createRequests += 1;
      }
      if (
        request.url().includes("/api/drafts/") &&
        request.method() === "PATCH"
      ) {
        updatePayloads.push(request.postDataJSON());
      }
    });
    let queueAttempts = 0;
    let queuePayload: {
      postingSlotId: string;
      postingSlotOccurrenceDate: string;
      localTime?: string;
    } | null = null;
    await page.route("**/api/drafts/*/queue", async (route) => {
      queuedDraftIds.push(route.request().url().split("/").at(-2) ?? "");
      const payload = route.request().postDataJSON() as NonNullable<typeof queuePayload>;
      queuePayload = payload;
      queueAttempts += 1;
      if (queueAttempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "Queue temporarily unavailable" }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          scheduledAt: `${payload.postingSlotOccurrenceDate}T12:00:00.000Z`,
          scheduleStatus: "scheduled",
          planToPostOn: payload.postingSlotOccurrenceDate,
          firstComment: null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          postingSlotId: payload.postingSlotId,
          postingSlotOccurrenceDate: payload.postingSlotOccurrenceDate,
        }),
      });
    });

    await createForSlot.click();
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();
    await expect(
      editor.getByText(`This post will be scheduled for ${slotLabel} when saved.`),
    ).toBeVisible();
    await editor.getByLabel("Preview name").fill(`Slot-created post ${Date.now()}`);
    const body = "A post created directly from an open publishing slot.";
    await editor.locator("textarea").first().fill(body);
    const createResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/drafts") && response.request().method() === "POST",
    );
    await editor.getByRole("button", { name: "Save & schedule" }).click();
    const created = (await (await createResponse).json()) as { draft: { id: string } };
    draftsToDelete.push(created.draft.id);

    await expect(page.getByText("Queue temporarily unavailable")).toBeVisible();
    await expect(editor).toBeVisible();
    await expect(editor.locator("textarea").first()).toHaveValue(body);
    expect(createRequests).toBe(1);
    expect(queuedDraftIds).toEqual([created.draft.id]);

    const updatedTitle = `Retried slot-created post ${Date.now()}`;
    const updatedBody = `${body}\n\nUpdated before retry.`;
    await editor.getByLabel("Preview name").fill(updatedTitle);
    await editor.getByLabel("Preview name").press("Tab");
    await editor.locator("textarea").first().fill(updatedBody);
    await editor.getByRole("button", { name: "Save & schedule" }).click();
    await expect(editor).toBeHidden();
    expect(createRequests).toBe(1);
    expect(queuedDraftIds).toEqual([created.draft.id, created.draft.id]);
    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: updatedTitle }),
        expect.objectContaining({ body: updatedBody }),
      ]),
    );
    expect(queuePayload).toMatchObject({
      postingSlotId: expect.any(String),
      postingSlotOccurrenceDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      localTime: expect.stringMatching(/^\d{2}:\d{2}/),
    });
  });

  test("keeps queue scheduling untouched when slot-created post saving fails", async ({ page }) => {
    consoleGuard.allowConsoleError(/Failed to load resource.*500/i);
    const queue = page.getByRole("region", { name: "Posting queue" });
    const queueToggle = queue.getByRole("button", { name: /^Posting queue/ });
    if ((await queueToggle.getAttribute("aria-expanded")) === "false") {
      await queueToggle.click();
    }
    const createForSlot = queue.getByRole("button", { name: /^Create a post for / }).first();
    await expect(createForSlot).toBeVisible();

    let queueRequests = 0;
    await page.route("**/api/drafts/*/queue", async (route) => {
      queueRequests += 1;
      await route.abort();
    });
    await page.route("**/api/drafts", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Draft save failed" }),
      });
    });

    await createForSlot.click();
    const editor = page.getByRole("dialog");
    const body = "Keep this editor content after the save fails.";
    await editor.getByLabel("Preview name").fill("Failed slot-created post");
    await editor.locator("textarea").first().fill(body);
    await editor.getByRole("button", { name: "Save & schedule" }).click();

    await expect(page.getByText("Draft save failed")).toBeVisible();
    await expect(editor).toBeVisible();
    await expect(editor.locator("textarea").first()).toHaveValue(body);
    expect(queueRequests).toBe(0);
  });
});

async function createPost(page: Page, buttonName: string) {
  await page.getByRole("button", { name: "New post" }).click();
  await expect(page.getByLabel("Planning date")).toHaveCount(0);
  await page.getByLabel("Preview name").fill(`Unscheduled board post ${Date.now()}`);
  await page.locator("textarea").first().fill("An unscheduled post created directly from the board.");
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/drafts") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: buttonName }).click();
  const response = await responsePromise;
  const data = (await response.json()) as { draft: { id: string; schedule_status: string | null } };
  return data.draft;
}

function futureDatetimeLocal() {
  const date = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T12:00`;
}
