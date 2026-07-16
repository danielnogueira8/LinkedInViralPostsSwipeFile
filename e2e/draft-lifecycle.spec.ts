import { expect, test, type Page, type Route } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

test.describe.configure({ mode: "serial" });

test.describe("Cowork draft lifecycle", () => {
  let consoleGuard: ReturnType<typeof failOnConsoleErrors>;
  const draftsToDelete: string[] = [];
  const chatsToDelete: string[] = [];

  test.beforeEach(async ({ page }, testInfo) => {
    consoleGuard = failOnConsoleErrors(page, testInfo);
  });

  test.afterEach(async ({ page }) => {
    const cleanupFailures: string[] = [];
    for (const id of draftsToDelete.splice(0)) {
      try {
        const result = await page.evaluate(async (draftId) => {
          const current = await fetch(`/api/drafts/${draftId}`, { cache: "no-store" });
          const currentPayload = await current.json();
          const isScheduled = currentPayload?.draft?.schedule_status === "scheduled";
          const unscheduleStatus = isScheduled
            ? (await fetch(`/api/drafts/${draftId}/schedule`, { method: "DELETE" })).status
            : 204;
          const remove = await fetch(`/api/drafts/${draftId}`, { method: "DELETE" });
          return { unscheduleStatus, removeStatus: remove.status };
        }, id);
        if (result.unscheduleStatus >= 500 || result.removeStatus >= 300) {
          cleanupFailures.push(
            `draft ${id}: unschedule ${result.unscheduleStatus}, delete ${result.removeStatus}`,
          );
        }
      } catch (error) {
        cleanupFailures.push(`draft ${id}: ${(error as Error).message}`);
      }
    }
    for (const id of chatsToDelete.splice(0)) {
      try {
        const status = await page.evaluate(async (chatId) => {
          const response = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
          return response.status;
        }, id);
        if (status >= 300) cleanupFailures.push(`chat ${id}: delete ${status}`);
      } catch (error) {
        cleanupFailures.push(`chat ${id}: ${(error as Error).message}`);
      }
    }
    let consoleFailure: Error | null = null;
    try {
      await consoleGuard.assertNoErrors();
    } catch (error) {
      consoleFailure = error as Error;
    }
    if (cleanupFailures.length || consoleFailure) {
      throw new Error(
        [...cleanupFailures.map((failure) => `cleanup: ${failure}`), consoleFailure?.message]
          .filter(Boolean)
          .join("\n"),
      );
    }
  });

  test("saves a Cowork artifact, reviews it on the board, and schedules without publishing", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const chat = await createChat(page, `Draft lifecycle E2E ${Date.now()}`);
    chatsToDelete.push(chat.id);

    const artifactTitle = `Cowork lifecycle post ${Date.now()}`;
    const artifactBody =
      "Three lessons from building a dependable publishing workflow.\n\nThe first is to make every transition explicit.";
    const sourceUrl = "https://www.linkedin.com/posts/example-lifecycle-source";
    const artifact = {
      id: "e2e-cowork-lifecycle-artifact",
      kind: "post",
      title: artifactTitle,
      body: artifactBody,
      meta: { source: "modeled_post", source_url: sourceUrl },
      media_attachments: [
        {
          id: "e2e-lifecycle-image",
          source: "library",
          assetId: "e2e-lifecycle-library-asset",
          type: "image",
          name: "lifecycle-image.png",
          mimeType: "image/png",
          size: 1024,
          uploadedAt: "2026-07-13T00:00:00.000Z",
        },
      ],
    };

    await page.route("**/api/media-assets/e2e-lifecycle-library-asset/preview", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    });

    await page.route(`**/api/chats/${chat.id}`, async (route) => {
      if (route.request().method() === "POST") {
        await route.continue();
        return;
      }
      if (route.request().method() === "PATCH") {
        // The displayed artifact is a deterministic response fixture rather than
        // a persisted chat_message row. Acknowledge its board_draft_id metadata
        // write; the board draft itself is still created by the real POST below.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, updated: true }),
        });
        return;
      }
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          chat,
          messages: [
            {
              id: "e2e-cowork-lifecycle-message",
              role: "assistant",
              content: "Here is the draft.",
              tool_calls: null,
              tool_call_id: null,
              artifacts: [artifact],
              created_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });
    await page.route(`**/api/chats/${chat.id}/artifacts`, async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, updated: true }),
        });
        return;
      }
      await route.continue();
    });

    let externalPublishAttempted = false;
    await page.route("**/api/cron/publish-scheduled**", failIfPublishing);
    await page.route("**/api/drafts/*/publish**", failIfPublishing);
    await page.route("**/*zernio*", failIfPublishing);

    async function failIfPublishing(route: Route) {
      externalPublishAttempted = true;
      await route.abort("blockedbyclient");
      throw new Error(`Lifecycle browser test attempted irreversible publishing: ${route.request().url()}`);
    }

    await page.goto(`/dashboard?chat=${chat.id}`);
    await expect(page.getByText("Three lessons from building a dependable publishing workflow.")).toBeVisible({
      timeout: 15_000,
    });

    const saveResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/chats/${chat.id}/artifacts`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save draft" }).click();
    const saveResponse = await saveResponsePromise;
    expect(saveResponse.ok()).toBe(true);
    const savePayload = (await saveResponse.json()) as {
      ok: boolean;
      artifact: { id: string };
    };
    expect(savePayload.ok).toBe(true);
    draftsToDelete.push(savePayload.artifact.id);
    await expect(page.getByRole("button", { name: "Saved" })).toBeDisabled();

    const saved = await readDraft(page, savePayload.artifact.id);
    expect(saved).toMatchObject({
      id: savePayload.artifact.id,
      body: artifactBody,
      kind: "post",
      status: "drafting",
      chat_id: chat.id,
    });
    expect(saved.meta).toMatchObject({ source: "modeled_post", source_url: sourceUrl });
    expect(saved.media_attachments).toEqual(artifact.media_attachments);

    await page.goto("/dashboard/posts");
    await expect(page.getByRole("heading", { name: /^Posts$/ })).toBeVisible();
    await page.getByText(artifactTitle, { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const revisedTitle = `${artifactTitle} reviewed`;
    await dialog.getByLabel("Preview name").fill(revisedTitle);
    await dialog.getByLabel("Preview name").press("Enter");
    await dialog.getByLabel("Status").selectOption("ready");
    await expect
      .poll(async () => readDraft(page, savePayload.artifact.id))
      .toMatchObject({
        title: revisedTitle,
        status: "ready",
        kind: "post",
        chat_id: chat.id,
        meta: { source: "modeled_post", source_url: sourceUrl },
        media_attachments: artifact.media_attachments,
      });

    await page.route("**/api/integrations/linkedin", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, connection: { connected: true } }),
      });
    });
    const scheduleAt = futureDatetimeLocal();
    await dialog.getByLabel("Publish date and time").fill(scheduleAt);
    await dialog.getByLabel("First comment").fill("Lifecycle test first comment.");
    const scheduleResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/drafts/${savePayload.artifact.id}/schedule`) &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: /^Schedule on LinkedIn$/ }).click();
    const scheduleResponse = await scheduleResponsePromise;
    expect(scheduleResponse.ok()).toBe(true);

    await expect(dialog.getByText(/Scheduled for/)).toBeVisible({ timeout: 8_000 });
    await expect
      .poll(async () => readScheduleState(savePayload.artifact.id))
      .toMatchObject({
        schedule_status: "scheduled",
        first_comment: "Lifecycle test first comment.",
      });
    const scheduledDraft = await readDraft(page, savePayload.artifact.id);
    expect(scheduledDraft).toMatchObject({
      kind: "post",
      chat_id: chat.id,
      meta: { source: "modeled_post", source_url: sourceUrl },
      media_attachments: artifact.media_attachments,
    });
    expect(externalPublishAttempted).toBe(false);
  });

  test("generates, refines, copies, saves, schedules, and cancels one Cowork draft", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/dashboard");
    const chat = await createChat(page, `Cowork full lifecycle ${Date.now()}`);
    chatsToDelete.push(chat.id);

    const artifactId = "e2e-cowork-full-lifecycle-artifact";
    const originalBody =
      "Reliable content systems make the next action obvious.\n\nStart by making every handoff explicit.";
    const refinedBody =
      "Your content workflow is only as reliable as its vaguest handoff.\n\nStart by making every handoff explicit.";
    let currentArtifact = {
      id: artifactId,
      kind: "post",
      title: `Cowork full lifecycle post ${Date.now()}`,
      body: originalBody,
      meta: {},
    };
    let streamCount = 0;

    await page.route(`**/api/chats/${chat.id}/stream`, async (route) => {
      streamCount += 1;
      const payload = route.request().postDataJSON() as {
        refineTargetId?: string;
        refineInstruction?: string;
      };
      if (streamCount === 1) {
        expect(payload.refineTargetId).toBeUndefined();
      } else {
        expect(payload).toMatchObject({
          refineTargetId: artifactId,
          refineInstruction: "Make the hook punchier",
        });
        currentArtifact = { ...currentArtifact, body: refinedBody };
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          sse("artifact", currentArtifact) +
          sse("done", { artifacts: [currentArtifact] }),
      });
    });

    await page.route(`**/api/chats/${chat.id}`, async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, updated: true }),
        });
        return;
      }
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          chat: { ...chat, running: false },
          messages: streamCount
            ? [
                {
                  id: "e2e-full-lifecycle-assistant",
                  role: "assistant",
                  content: "Here is the draft.",
                  tool_calls: null,
                  tool_call_id: null,
                  artifacts: [currentArtifact],
                  created_at: new Date().toISOString(),
                },
              ]
            : [],
        }),
      });
    });
    await page.route(`**/api/chats/${chat.id}/artifacts`, async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, updated: true }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/integrations/linkedin", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, connection: { connected: true } }),
      });
    });

    let externalPublishAttempted = false;
    const failIfPublishing = async (route: Route) => {
      externalPublishAttempted = true;
      await route.abort("blockedbyclient");
      throw new Error(
        `Lifecycle browser test attempted irreversible publishing: ${route.request().url()}`,
      );
    };
    await page.route("**/api/cron/publish-scheduled**", failIfPublishing);
    await page.route("**/api/drafts/*/publish**", failIfPublishing);
    await page.route("**/*zernio*", failIfPublishing);

    await page.goto(`/dashboard?chat=${chat.id}`);
    const composer = page.getByPlaceholder("What do you want to write?");
    await composer.fill("Write one post about reliable content workflows.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(originalBody.split("\n")[0])).toBeVisible();

    await page.getByRole("button", { name: "Refine", exact: true }).click();
    await page.getByPlaceholder("Or describe a change…").fill("Make the hook punchier");
    await page.getByRole("button", { name: "Refine", exact: true }).last().click();
    await expect(page.getByText(refinedBody.split("\n")[0])).toBeVisible();
    expect(streamCount).toBe(2);

    await page.getByRole("button", { name: /^Copy$/ }).last().click();
    await expect(page.getByRole("button", { name: "Copied" }).last()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(refinedBody);

    const saveResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/chats/${chat.id}/artifacts`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save draft" }).click();
    const saveResponse = await saveResponsePromise;
    const savePayload = (await saveResponse.json()) as {
      ok: boolean;
      artifact: { id: string };
    };
    expect(saveResponse.ok()).toBe(true);
    expect(savePayload.ok).toBe(true);
    draftsToDelete.push(savePayload.artifact.id);
    await expect(page.getByRole("button", { name: "Saved" })).toBeDisabled();
    await expect.poll(() => readDraft(page, savePayload.artifact.id)).toMatchObject({
      body: refinedBody,
      chat_id: chat.id,
      status: "drafting",
    });

    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await page.getByLabel("Publish date and time").fill(futureDatetimeLocal());
    await page.getByLabel("First comment").fill("Full lifecycle first comment.");
    await page.getByRole("button", { name: "Schedule", exact: true }).last().click();
    await expect(page.getByText(/Scheduled for/)).toBeVisible();
    await expect.poll(() => readScheduleState(savePayload.artifact.id)).toMatchObject({
      schedule_status: "scheduled",
      first_comment: "Full lifecycle first comment.",
    });

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => readScheduleState(savePayload.artifact.id)).toMatchObject({
      schedule_status: null,
      scheduled_at: null,
    });
    await expect(
      page.getByRole("button", {
        name: "Schedule",
        description: "Schedule this draft to publish on LinkedIn",
      }),
    ).toBeVisible();
    expect(externalPublishAttempted).toBe(false);
  });
});

async function createChat(page: Page, title: string) {
  return page.evaluate(async (chatTitle) => {
    const response = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: chatTitle }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Failed to create lifecycle chat");
    return data.chat as {
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
    };
  }, title);
}

async function readDraft(page: Page, id: string) {
  return page.evaluate(async (draftId) => {
    const response = await fetch(`/api/drafts/${draftId}`, { cache: "no-store" });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Failed to read lifecycle draft");
    return data.draft as {
      id: string;
      title: string | null;
      body: string;
      kind: string;
      status: string;
      chat_id: string | null;
      meta: Record<string, unknown> | null;
      media_attachments: unknown[];
      scheduled_at: string | null;
      schedule_status: string | null;
      first_comment: string | null;
      plan_to_post_on: string | null;
    };
  }, id);
}

function futureDatetimeLocal() {
  const date = new Date(Date.now() + 36 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readScheduleState(id: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase E2E credentials are missing");
  const query = new URLSearchParams({
    id: `eq.${id}`,
    select: "schedule_status,scheduled_at,first_comment,plan_to_post_on",
    limit: "1",
  });
  const response = await fetch(`${url}/rest/v1/chat_artifacts?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`Failed to read schedule fixture (${response.status})`);
  const rows = (await response.json()) as Array<{
    schedule_status: string | null;
    scheduled_at: string | null;
    first_comment: string | null;
    plan_to_post_on: string | null;
  }>;
  if (!rows[0]) throw new Error("Scheduled draft fixture disappeared");
  return rows[0];
}
