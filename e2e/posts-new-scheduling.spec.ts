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
});

async function createPost(page: Page, buttonName: string) {
  await page.getByRole("button", { name: "New post" }).click();
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
