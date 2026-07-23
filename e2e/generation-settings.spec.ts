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

  test("sends explicit Ask/Create/Edit commands and resets every completed turn to Ask", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const chatId = await createChat(page);
    chatsToDelete.push(chatId);

    const streamBodies: Array<Record<string, unknown>> = [];
    const postId = "e2e-visible-edit-post";
    const selectedPostId = "e2e-visible-edit-post-1";
    const replacementPostId = "e2e-visible-edit-post-2";
    const originalPost = {
      id: postId,
      kind: "post",
      title: "Deterministic Cowork",
      body: "A deterministic interface makes the next safe action obvious to every user.",
      meta: {},
    };
    const editedPost = {
      ...originalPost,
      id: replacementPostId,
      body: "A deterministic interface makes the next safe edit obvious to every user.",
    };
    const createdPosts = [
      {
        ...originalPost,
        id: selectedPostId,
        body: "Explicit Ask boundaries keep feedback from becoming an accidental new draft.",
      },
      {
        ...originalPost,
        id: replacementPostId,
        body: "Exact Create counts make generated Post sets predictable and testable.",
      },
      originalPost,
    ];
    let persistedArtifacts: Array<typeof originalPost> = [];
    let releaseCreateStream: (() => void) | undefined;
    const createStreamGate = new Promise<void>((resolve) => {
      releaseCreateStream = resolve;
    });
    await page.route(`**/api/chats/${chatId}/stream`, async (route) => {
      streamBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      if (streamBodies.length === 2) await createStreamGate;
      const artifacts =
        streamBodies.length === 2
          ? createdPosts
          : streamBodies.length === 3
            ? [editedPost]
            : [];
      if (streamBodies.length === 2) {
        persistedArtifacts = createdPosts;
      } else if (streamBodies.length === 3) {
        persistedArtifacts = persistedArtifacts.map((artifact) =>
          artifact.id === editedPost.id ? editedPost : artifact,
        );
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: artifacts.length
          ? artifacts.map((artifact) => sse("artifact", artifact)).join("") +
            sse("done", { artifacts })
          : sse("done", { artifacts: [] }),
      });
    });
    await page.route(`**/api/chats/${chatId}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          chat: { id: chatId, title: "Visible Edit E2E", running: false },
          messages: persistedArtifacts.length
            ? [
                {
                  id: "e2e-visible-edit-assistant",
                  role: "assistant",
                  content: "Here are the Posts.",
                  tool_calls: null,
                  tool_call_id: null,
                  artifacts: persistedArtifacts,
                  created_at: new Date().toISOString(),
                },
              ]
            : [],
        }),
      });
    });
    await page.route(`**/api/chats/${chatId}/artifacts`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      const payload = route.request().postDataJSON() as { artifactId: string };
      persistedArtifacts = persistedArtifacts.filter(
        (artifact) => artifact.id !== payload.artifactId,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(`/dashboard?chat=${chatId}`);
    const composer = page.getByPlaceholder("Ask Cowork anything…");
    await expect(composer).toBeVisible();

    const commandGroup = page.getByRole("group", { name: "Cowork command" });
    const askButton = commandGroup.getByRole("button", { name: "Ask", exact: true });
    const createButton = commandGroup.getByRole("button", { name: "Create", exact: true });
    const editButton = commandGroup.getByRole("button", { name: "Edit", exact: true });
    await expect(askButton).toHaveAttribute("aria-pressed", "true");
    await expect(editButton).toHaveCount(0);

    await composer.fill("Write three posts even though this turn is Ask.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => streamBodies.length).toBe(1);
    expect(streamBodies[0]).toMatchObject({
      message: "Write three posts even though this turn is Ask.",
      command: { kind: "ask" },
    });
    await expect(askButton).toHaveAttribute("aria-pressed", "true");

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
    await expect(editButton).toHaveCount(0);
    releaseCreateStream?.();
    expect(streamBodies[1]).toMatchObject({
      message: "Review my current post and give feedback only.",
      command: { kind: "create", count: 3 },
      generationConfig: { version: 1, draftCount: 3 },
    });
    await expect(editButton).toBeVisible();
    await editButton.click();
    const postPicker = page.getByLabel("Post to edit");
    await expect(postPicker).toHaveValue(postId);
    await postPicker.selectOption(selectedPostId);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete draft" }).last().click();
    await expect(postPicker).toHaveValue("");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await postPicker.selectOption(replacementPostId);
    const targetedEditButton = commandGroup.getByRole("button", {
      name: "Edit · Post 1",
      exact: true,
    });
    await expect(targetedEditButton).toHaveAttribute("aria-pressed", "true");
    await expect(postPicker).toHaveValue(replacementPostId);
    const editScope = page.getByRole("group", { name: "Edit scope" });
    await editScope.getByRole("button", { name: "Hook only" }).click();
    const editComposer = page.getByPlaceholder("What should change in Post 1?");
    await editComposer.fill("Make the hook punchier.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => streamBodies.length).toBe(3);
    expect(streamBodies[2]).toMatchObject({
      message: "Make the hook punchier.",
      command: { kind: "edit", targetPostId: replacementPostId, scope: "hook" },
    });
    expect(streamBodies[2]).not.toHaveProperty("generationConfig");
    await expect(page.getByText(editedPost.body)).toBeVisible();
    await expect(askButton).toHaveAttribute("aria-pressed", "true");

    await editButton.click();
    await expect(
      commandGroup.getByRole("button", { name: /^Edit · Post / }),
    ).toHaveAttribute("aria-pressed", "true");
    const deleteButtons = page.getByRole("button", { name: "Delete draft" });
    await expect(deleteButtons).toHaveCount(2);
    for (const remaining of [1, 0]) {
      page.once("dialog", (dialog) => dialog.accept());
      await deleteButtons.last().click();
      await expect(deleteButtons).toHaveCount(remaining);
    }
    await expect(editButton).toHaveCount(0);
    await expect(askButton).toHaveAttribute("aria-pressed", "true");
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
