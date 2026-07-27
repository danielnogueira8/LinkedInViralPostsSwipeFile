import { expect, test, type Page } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

type DraftFixture = {
  id: string;
  title: string | null;
  body: string;
  status: string;
};

test.describe.configure({ mode: "serial" });

test.describe("UI loading and performance guardrails", () => {
  let consoleGuard: ReturnType<typeof failOnConsoleErrors>;
  const draftsToDelete: string[] = [];
  const chatsToDelete: string[] = [];
  const bookmarksToDelete: string[] = [];

  test.beforeEach(async ({ page }, testInfo) => {
    consoleGuard = failOnConsoleErrors(page, testInfo);
  });

  test.afterEach(async ({ page }) => {
    for (const id of draftsToDelete.splice(0)) {
      await page.evaluate(async (draftId) => {
        await fetch(`/api/drafts/${draftId}`, { method: "DELETE" });
      }, id).catch(() => undefined);
    }
    for (const id of chatsToDelete.splice(0)) {
      await page.evaluate(async (chatId) => {
        await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
      }, id).catch(() => undefined);
    }
    for (const id of bookmarksToDelete.splice(0)) {
      await page.evaluate(async (bookmarkId) => {
        const response = await fetch(`/api/saved-posts?id=${encodeURIComponent(bookmarkId)}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(`bookmark cleanup failed (${response.status})`);
      }, id);
    }
    await consoleGuard.assertNoErrors();
  });

  test("dashboard route shows the Cowork shell and composer quickly", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page.getByRole("button", { name: /new session/i }).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByPlaceholder("What do you want to write?")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("main, [role=main]").first()).toBeVisible();
  });

  test("lead magnets route shows useful content quickly", async ({ page }) => {
    await page.goto("/dashboard/lead-magnets");

    await expect(page.getByRole("heading", { name: /lead magnets/i }).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText(/resource library/i).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("main, [role=main]").first()).toBeVisible();
  });

  test("posts route shows loading feedback quickly, then renders the board", async ({ page }) => {
    const delayPostsRsc = true;
    await page.route("**/dashboard/posts**", async (route) => {
      const url = route.request().url();
      if (delayPostsRsc && url.includes("_rsc=")) {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      await route.continue();
    });

    await page.goto("/dashboard/swipe");
    await expect(page.getByRole("heading", { name: /swipe file/i })).toBeVisible();

    await page.getByRole("link", { name: /^Posts$/ }).click();

    const loadingOrContent = await Promise.race([
      page
        .getByText("Loading posts")
        .waitFor({ state: "visible", timeout: 3_000 })
        .then(() => "loading" as const)
        .catch(() => null),
      page
        .getByRole("heading", { name: /^Posts$/ })
        .waitFor({ state: "visible", timeout: 3_000 })
        .then(() => "content" as const)
        .catch(() => null),
    ]);
    expect(loadingOrContent).not.toBeNull();

    await expect(page.getByRole("heading", { name: /^Posts$/ })).toBeVisible({
      timeout: 15_000,
    });

    for (const col of ["Idea", "Draft", "Ready", "Scheduled", "Posted"]) {
      await expect(
        page.locator(`text=${col}`).locator("visible=true").first(),
      ).toBeVisible();
    }
    await expect(page.locator("main, [role=main]").first()).toBeVisible();
  });

  test("swipe-file bookmarking updates the UI and bookmarks tab without a hard refresh", async ({ page }) => {
    await page.goto("/dashboard/swipe");
    await expect(page.getByRole("heading", { name: /swipe file/i })).toBeVisible();

    const bookmarkButton = page.getByRole("button", { name: /bookmark this post/i }).first();
    expect(await bookmarkButton.count(), "isolated E2E workspace must contain a bookmarkable post").toBeGreaterThan(0);
    const clickedBookmarkButton = await bookmarkButton.elementHandle();
    expect(clickedBookmarkButton).not.toBeNull();

    const beforeUrl = page.url();
    const saveResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/saved-posts",
    );
    await clickedBookmarkButton!.click();
    const menu = page.getByRole("menu");
    if (await menu.isVisible().catch(() => false)) {
      await menu.getByRole("menuitem").first().click();
    }
    const savePayload = (await (await saveResponsePromise).json()) as {
      alreadySaved: boolean;
      saved: { id: string };
    };
    expect(savePayload.alreadySaved).toBe(false);
    bookmarksToDelete.push(savePayload.saved.id);

    await expect
      .poll(
        async () =>
          clickedBookmarkButton!.evaluate(
            (button) =>
              button.getAttribute("aria-label") === "Bookmarked" &&
              !!button.querySelector("svg.fill-current"),
          ),
        { timeout: 8_000 },
      )
      .toBe(true);
    expect(page.url()).toBe(beforeUrl);

    await page.getByRole("link", { name: /^Bookmarks/ }).click();
    await expect(page.getByRole("heading", { name: /bookmarks/i }).first()).toBeVisible();
    await expect(page.locator("main, [role=main]").first()).toBeVisible();
    await expect(page.locator('[id^="saved-"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("starting a weekly batch moves to chat and shows progress plus draft previews", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const chat = await createChat(page, `Weekly batch — E2E ${Date.now()}`);
    chatsToDelete.push(chat.id);

    let batchPolls = 0;
    let batchStarted = false;
    await page.route("**/api/batch/weekly", async (route) => {
      if (route.request().method() === "POST") {
        batchStarted = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, runId: "e2e-run", chatId: chat.id }),
        });
        return;
      }
      if (!batchStarted) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, run: null }),
        });
        return;
      }
      batchPolls += 1;
      const done = batchPolls >= 3;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          run: {
            id: "e2e-run",
            status: done ? "done" : "running",
            stage: done
              ? "1 draft ready to review · 2 couldn't be adapted this time"
              : batchPolls < 2
                ? "Finding this week's top posts"
                : "Drafting 1 of 3",
            total: 3,
            attempted: done ? 3 : Math.min(batchPolls, 1),
            created: batchPolls < 2 ? 0 : 1,
            error: null,
          },
        }),
      });
    });

    await page.route(`**/api/chats/${chat.id}`, async (route) => {
      const artifacts =
        batchPolls < 2
          ? null
          : [
              {
                id: "e2e-weekly-draft-1",
                kind: "post",
                title: "E2E weekly draft one",
                body: "A draft that appears before the batch finishes.",
                meta: { source: "weekly_batch", source_url: null },
              },
            ];
      const messages = [
        {
          id: "e2e-batch-intro",
          role: "assistant",
          content: "Building your weekly batch now.",
          tool_calls: null,
          tool_call_id: null,
          artifacts,
          created_at: new Date().toISOString(),
        },
        ...(batchPolls >= 3
          ? [
              {
                id: "e2e-batch-done",
                role: "assistant",
                content:
                  "1 draft ready to review · 2 couldn't be adapted this time. Review them on your Posts page to approve the ones you want.",
                tool_calls: null,
                tool_call_id: null,
                artifacts: null,
                created_at: new Date().toISOString(),
              },
            ]
          : []),
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          chat,
          messages,
        }),
      });
    });
    await page.route("**/api/batch/weekly/slots?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          slots: [
            {
              slot_index: 0,
              source_first_line: "A source post being adapted",
              source_url: null,
              is_lead_magnet: false,
              skill_label: "Regular Post",
              status: batchPolls < 2 ? "drafting" : "filed",
              draft_title: batchPolls < 2 ? null : "E2E weekly draft one",
              error: null,
            },
            {
              slot_index: 1,
              source_first_line: "Another source post being adapted",
              source_url: null,
              is_lead_magnet: false,
              skill_label: "Regular Post",
              status: batchPolls >= 3 ? "skipped" : "queued",
              draft_title: null,
              error: batchPolls >= 3 ? "Generated draft was too short or incomplete." : null,
            },
            {
              slot_index: 2,
              source_first_line: "A third source post being adapted",
              source_url: null,
              is_lead_magnet: true,
              skill_label: "Lead Magnet Post",
              status: batchPolls >= 3 ? "skipped" : "queued",
              draft_title: null,
              error: batchPolls >= 3 ? "Generated draft was too short or incomplete." : null,
            },
          ],
        }),
      });
    });

    await page.goto("/dashboard/posts");
    await page.getByRole("button", { name: /generate this week's batch/i }).click();

    await expect(page).toHaveURL(new RegExp(`/dashboard\\?chat=${chat.id}`));
    await expect(
      page.getByText(/Finding this week's top posts|Drafting 1 of 3/).first(),
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/drafts ready|writing now/i).first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(/Drafts appear here one by one/i)).toBeVisible();
    await expect(page.getByText("E2E weekly draft one").first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(/Pending review/i)).toBeVisible();
    await expect(
      page.getByText(/1 draft ready to review · 2 couldn't be adapted this time/).first(),
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByText(/Couldn't adapt this one/i).first()).toBeVisible();
  });

  test("batch draft approval moves a pending draft to ready", async ({ page }) => {
    await page.goto("/dashboard/posts");
    const title = `E2E review draft ${Date.now()}`;
    const draft = await createDraft(page, {
      title,
      body: "Review-gated draft created by the UI loading spec.",
      status: "drafting",
    });
    draftsToDelete.push(draft.id);
    await patchDraftStatus(page, draft.id, "pending_review");

    await page.goto("/dashboard/posts");
    await expect(page.getByText(/Review this week's batch/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(title)).toBeVisible();

    await page.getByLabel("Approve to Ready").first().click();
    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => draftStatus(page, draft.id), { timeout: 8_000 })
      .toBe("ready");
    await expect(
      page.locator("div").filter({ hasText: "Ready" }).first(),
    ).toBeVisible();
  });

  test("calendar scheduling and first-comment controls stay responsive", async ({ page }) => {
    await page.goto("/dashboard/posts");
    const title = `E2E schedulable post ${Date.now()}`;
    const draft = await createDraft(page, {
      title,
      body: "This draft can be scheduled by the UI loading spec.",
      status: "ready",
    });
    draftsToDelete.push(draft.id);

    await page.route("**/api/integrations/linkedin", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, connection: { connected: true } }),
      });
    });
    await page.route(`**/api/drafts/${draft.id}/schedule`, async (route) => {
      const requestBody = route.request().postDataJSON() as {
        scheduledAt?: string;
        firstComment?: string | null;
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          scheduledAt: requestBody.scheduledAt,
          scheduleStatus: "scheduled",
          planToPostOn: requestBody.scheduledAt?.slice(0, 10),
          firstComment: requestBody.firstComment ?? null,
        }),
      });
    });

    await page.goto("/dashboard/posts");
    await expect(page.getByRole("heading", { name: /^Posts$/ })).toBeVisible();

    await page.getByText(title).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: /^Schedule on LinkedIn$/ })).toBeVisible({
      timeout: 8_000,
    });
    const addToQueueButton = page.getByRole("button", {
      name: /^Add to Queue$/,
    });
    const scheduleButton = page.getByRole("button", {
      name: /^Schedule on LinkedIn$/,
    });
    await expect(addToQueueButton).toBeVisible();
    await expect(page.getByText(/^\d+\/3,?000$/)).toHaveCount(0);
    const [queueBox, scheduleBox] = await Promise.all([
      addToQueueButton.boundingBox(),
      scheduleButton.boundingBox(),
    ]);
    expect(queueBox?.y).toBe(scheduleBox?.y);

    await page.getByLabel("Publish date and time").fill(futureDatetimeLocal());
    await page.getByLabel("First comment").fill("First comment from the UI loading spec.");
    await page.getByRole("button", { name: /^Schedule on LinkedIn$/ }).click();

    await expect(page.getByText(/Scheduled for/)).toBeVisible({ timeout: 8_000 });
    await expect(page.locator("main, [role=main]").first()).toBeVisible();
  });
});

async function createChat(page: Page, title: string) {
  return page.evaluate(async (chatTitle) => {
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: chatTitle }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to create test chat");
    return data.chat as {
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
    };
  }, title);
}

async function createDraft(
  page: Page,
  draft: { title: string; body: string; status: "drafting" | "ready" },
): Promise<DraftFixture> {
  return page.evaluate(async (input) => {
    const res = await fetch("/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to create test draft");
    return data.draft as DraftFixture;
  }, draft);
}

async function patchDraftStatus(page: Page, id: string, status: string) {
  await page.evaluate(
    async ({ draftId, nextStatus }) => {
      const res = await fetch(`/api/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to patch test draft");
    },
    { draftId: id, nextStatus: status },
  );
}

async function draftStatus(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (draftId) => {
    const res = await fetch(`/api/drafts/${draftId}`, { cache: "no-store" });
    const data = await res.json();
    return data.ok ? (data.draft.status as string | null) : null;
  }, id);
}

function futureDatetimeLocal() {
  const date = new Date(Date.now() + 36 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}
