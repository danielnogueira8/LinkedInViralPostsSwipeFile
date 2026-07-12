import { expect, test } from "@playwright/test";

test.describe("chat client reconciliation races", () => {
  const chatsToDelete: string[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of chatsToDelete.splice(0)) {
      await page
        .evaluate(async (chatId) => {
          await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
        }, id)
        .catch(() => undefined);
    }
  });

  test("E: a delayed pre-stream failure does not overwrite a newer session composer", async ({
    page,
  }) => {
    let releaseFailure!: () => void;
    const failureReleased = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let streamIntercepted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      streamIntercepted = resolve;
    });
    let failureDelivered!: () => void;
    const deliveredFailure = new Promise<void>((resolve) => {
      failureDelivered = resolve;
    });

    await page.route("**/api/chats/*/stream", async (route) => {
      streamIntercepted();
      await failureReleased;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Delayed pre-stream failure" }),
      });
      failureDelivered();
    });

    await page.goto("/dashboard");
    await page.getByRole("button", { name: /new session/i }).first().click();

    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chats",
    );
    const composer = page.getByPlaceholder(/ask for a post or hook/i);
    await composer.fill("stale request from the previous session");
    await page.getByRole("button", { name: "Send message" }).click();

    const created = (await (await createResponse).json()) as {
      chat: { id: string };
    };
    chatsToDelete.push(created.chat.id);
    await streamStarted;

    await page.getByRole("button", { name: /new session/i }).first().click();
    await composer.fill("newer unsent draft for the new session");
    releaseFailure();
    await deliveredFailure;
    await expect(page.getByText("Delayed pre-stream failure")).toBeVisible();

    await expect(composer).toHaveValue("newer unsent draft for the new session", {
      timeout: 2_000,
    });
  });

  test("G: save-then-schedule detects a conflicting artifact metadata write", async ({
    page,
  }) => {
    const artifact = {
      id: "artifact-save-schedule-race",
      kind: "post",
      title: "Save then schedule race",
      body: "A generated draft used to exercise client metadata reconciliation.",
      meta: {},
    };
    let chatId: string | null = null;
    let metadataWrites = 0;
    let resolveConflictObserved!: () => void;
    const conflictObserved = new Promise<void>((resolve) => {
      resolveConflictObserved = resolve;
    });

    await page.route("**/api/chats/*/stream", async (route) => {
      chatId = new URL(route.request().url()).pathname.split("/")[3] ?? null;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse("artifact", artifact),
      });
    });

    await page.route("**/api/chats/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() !== "GET" ||
        url.pathname.endsWith("/stream") ||
        url.pathname.endsWith("/artifacts")
      ) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          chat: { id: chatId, title: "Save then schedule race", running: false },
          messages: [
            {
              id: "user-save-schedule-race",
              role: "user",
              content: "Generate a draft for scheduling.",
              tool_calls: null,
              tool_call_id: null,
              artifacts: null,
              created_at: "2026-07-11T10:00:00.000Z",
            },
            {
              id: "assistant-save-schedule-race",
              role: "assistant",
              content: "Here is the draft.",
              tool_calls: null,
              tool_call_id: null,
              artifacts: [artifact],
              created_at: "2026-07-11T10:00:01.000Z",
            },
          ],
        }),
      });
    });

    await page.route("**/api/chats/*/artifacts", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            artifact: { id: "board-draft-save-schedule-race" },
          }),
        });
        return;
      }
      if (route.request().method() === "PATCH") {
        metadataWrites += 1;
        const payload = route.request().postDataJSON() as {
          meta?: { schedule_status?: string };
        };
        if (payload.meta?.schedule_status === "scheduled") {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: "This card changed elsewhere — reload and try again.",
            }),
          });
          resolveConflictObserved();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, updated: true }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/drafts/board-draft-save-schedule-race/schedule", async (route) => {
      const payload = route.request().postDataJSON() as {
        scheduledAt: string;
        planToPostOn: string;
        firstComment: string | null;
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          scheduledAt: payload.scheduledAt,
          planToPostOn: payload.planToPostOn,
          firstComment: payload.firstComment,
        }),
      });
    });

    await page.goto("/dashboard");
    await page.getByRole("button", { name: /new session/i }).first().click();

    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chats",
    );
    const composer = page.getByPlaceholder(/ask for a post or hook/i);
    await composer.fill("Generate a draft for scheduling.");
    await page.getByRole("button", { name: "Send message" }).click();
    const created = (await (await createResponse).json()) as {
      chat: { id: string };
    };
    chatId = created.chat.id;
    chatsToDelete.push(created.chat.id);

    await expect(page.getByText(artifact.body)).toBeVisible();
    await page.getByRole("button", { name: "Schedule", exact: true }).first().click();
    await page.getByLabel("Publish date and time").fill(futureDatetimeLocal());
    await page.getByRole("button", { name: "Schedule", exact: true }).last().click();

    await conflictObserved;
    expect(metadataWrites).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("This card changed elsewhere — reload and try again.")).toBeVisible({
      timeout: 2_000,
    });
  });

  test("a modeled source stays with its owning fresh chat", async ({ page }) => {
    await page.goto("/dashboard");
    const previous = await createChat(page, `Previous chat ${Date.now()}`);
    chatsToDelete.push(previous.id);

    const sourceId = "22222222-2222-4222-8222-222222222222";
    await page.route(`**/api/model-source/${sourceId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          source: {
            id: sourceId,
            author_name: "Modeled Creator",
            author_avatar: null,
            post_text: "A source post that belongs only to the fresh handoff chat.",
            post_type: "regular",
            source: "template",
            source_post_id: "source-post-1",
            partial: false,
          },
        }),
      });
    });

    await page.route("**/api/model-source", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, id: sourceId, partial: false }),
      });
    });

    await page.goto("/dashboard/templates");
    const handoffResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chats",
    );
    await page.getByRole("button", { name: /model with cowork/i }).first().click();
    const handoffPayload = (await (await handoffResponse).json()) as {
      chat: { id: string };
    };
    const handoffChatId = handoffPayload.chat.id;
    chatsToDelete.push(handoffChatId);
    await expect(page.getByText("Filling template", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?chat=${handoffChatId}$`));

    await page.getByText(previous.title, { exact: true }).locator("..").click();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?chat=${previous.id}$`));
    await expect(page.getByText("Filling template", { exact: true })).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?chat=${handoffChatId}$`));
    await expect(page.getByText("Filling template", { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?chat=${handoffChatId}$`));
    await expect(page.getByText("Filling template", { exact: true })).toHaveCount(0);
  });
});

async function createChat(page: import("@playwright/test").Page, title: string) {
  return page.evaluate(async (chatTitle) => {
    const response = await fetch("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: chatTitle }),
    });
    const payload = await response.json();
    if (!payload.ok || !payload.chat?.id) throw new Error(payload.error || "create failed");
    return payload.chat as { id: string; title: string };
  }, title);
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function futureDatetimeLocal(): string {
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
