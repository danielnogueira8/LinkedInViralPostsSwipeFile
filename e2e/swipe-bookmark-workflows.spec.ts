import { expect, test, type Page } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

test.describe("Swipe File and bookmark workflows", () => {
  const chatsToDelete: string[] = [];
  const bookmarksToDelete: string[] = [];
  const directBookmarksToDelete: string[] = [];
  const sharesToDelete: string[] = [];
  let consoleGuard: ReturnType<typeof failOnConsoleErrors>;

  test.beforeEach(async ({ page }, testInfo) => {
    await page.route("https://media.licdn.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    await page.route("**/_next/image?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    consoleGuard = failOnConsoleErrors(page, testInfo);
  });

  test.afterEach(async ({ page }) => {
    for (const id of bookmarksToDelete.splice(0)) {
      await page
        .evaluate(async (savedPostId) => {
          await fetch(`/api/saved-posts?id=${encodeURIComponent(savedPostId)}`, {
            method: "DELETE",
          });
        }, id)
        .catch(() => undefined);
    }
    for (const id of chatsToDelete.splice(0)) {
      await page
        .evaluate(async (chatId) => {
          await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
        }, id)
        .catch(() => undefined);
    }
    const directBookmarkIds = directBookmarksToDelete.splice(0);
    if (directBookmarkIds.length > 0) {
      await adminRest(
        "saved_posts",
        "DELETE",
        undefined,
        `id=in.(${directBookmarkIds.join(",")})`,
      );
    }
    const shareIds = sharesToDelete.splice(0);
    if (shareIds.length > 0) {
      await adminRest(
        "shared_bookmarks",
        "DELETE",
        undefined,
        `id=in.(${shareIds.join(",")})`,
      );
    }
    await consoleGuard.assertNoErrors();
  });

  for (const postType of ["regular", "lead_magnet"] as const) {
    test(`a ${postType} Swipe File post keeps its type in Bookmarks and can be removed`, async ({
      page,
    }) => {
      await page.goto(`/dashboard/swipe?type=${postType}`);
      await expect(page.getByRole("heading", { name: /swipe file/i }).first()).toBeVisible();

      const buttons = page.getByRole("button", { name: "Bookmark this post" });
      await expect(buttons.first()).toBeVisible();
      const available = await buttons.count();
      expect(
        available,
        `the seeded workspace needs a ${postType} Swipe File post`,
      ).toBeGreaterThan(0);

      let saved:
        | { id: string; post_type: "regular" | "lead_magnet" }
        | undefined;
      let attempts = 0;
      while (!saved && attempts < Math.min(available, 8)) {
        attempts += 1;
        // A completed attempt changes this button's accessible name to
        // "Bookmarked", so the first remaining locator advances to the next
        // candidate when the server reports that the previous one already existed.
        const button = buttons.first();
        const saveResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/saved-posts",
        );
        await button.click();
        const menu = page.getByRole("menu");
        const firstOutcome = await Promise.race([
          menu.waitFor({ state: "visible" }).then(() => "menu" as const),
          saveResponse.then(() => "saved" as const),
        ]);
        if (firstOutcome === "menu") {
          const ownLibrary = menu.getByRole("menuitem", { name: "My bookmarks" });
          await expect(ownLibrary).toHaveCount(1);
          await ownLibrary.click();
        }

        const response = await saveResponse;
        expect(response.ok()).toBe(true);
        const requestBody = response.request().postDataJSON() as {
          url: string;
          postType: "regular" | "lead_magnet";
        };
        const payload = (await response.json()) as {
          ok: true;
          alreadySaved: boolean;
          saved: { id: string; post_type: "regular" | "lead_magnet" };
        };
        expect(requestBody.postType).toBe(postType);
        expect(payload.saved.post_type).toBe(postType);
        if (!payload.alreadySaved) {
          saved = payload.saved;
          bookmarksToDelete.push(saved.id);
        }
      }

      expect(
        saved,
        `the seeded workspace needs one not-yet-bookmarked ${postType} post`,
      ).toBeDefined();
      await page.goto(`/dashboard/swipe?tab=bookmarks&type=${postType}`);
      const card = page.locator(`#saved-${saved!.id}`);
      await expect(card).toBeVisible();

      const deleteResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          new URL(response.url()).pathname === "/api/saved-posts" &&
          new URL(response.url()).searchParams.get("id") === saved!.id,
      );
      page.once("dialog", (dialog) => dialog.accept());
      await card.getByRole("button", { name: "Remove saved post" }).click();
      expect((await deleteResponse).ok()).toBe(true);
      await expect(card).toHaveCount(0);
      bookmarksToDelete.splice(bookmarksToDelete.indexOf(saved!.id), 1);
    });
  }

  for (const postType of ["regular", "lead_magnet"] as const) {
    test(`a ${postType} Swipe File source reaches its owning Cowork chat`, async ({
      page,
    }) => {
      await page.goto(`/dashboard/swipe?type=${postType}`);
      const modelButtons = page.getByRole("button", { name: "Model with Cowork" });
      await expect(modelButtons.first()).toBeVisible();
      expect(
        await modelButtons.count(),
        `the seeded workspace needs a ${postType} Swipe File post`,
      ).toBeGreaterThan(0);

      const stashResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/model-source",
      );
      const sourceFetch = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname.startsWith("/api/model-source/"),
      );
      const chatCreate = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/chats",
      );
      await modelButtons.first().click();
      const stashed = (await (await stashResponse).json()) as {
        ok: true;
        id: string;
      };

      const sourceResponse = await sourceFetch;
      expect(new URL(sourceResponse.url()).pathname).toBe(`/api/model-source/${stashed.id}`);
      const sourcePayload = (await sourceResponse.json()) as {
        ok: true;
        source: { post_type: "regular" | "lead_magnet" };
      };
      expect(sourcePayload.source.post_type).toBe(postType);

      const createResponse = await chatCreate;
      const created = (await createResponse.json()) as { chat: { id: string } };
      chatsToDelete.push(created.chat.id);
      await expect(page).toHaveURL(new RegExp(`/dashboard\\?chat=${created.chat.id}$`));
      await expect(page.getByText(/modeling after:/i)).toBeVisible();
      if (postType === "lead_magnet") {
        await expect(page.getByText("Lead Magnet: Auto", { exact: true })).toBeVisible();
      } else {
        await expect(page.getByText("Lead Magnet: Auto", { exact: true })).toHaveCount(0);
      }
    });
  }

  test("an unaccepted shared library cannot be read, written, removed, or modeled", async ({
    page,
  }) => {
    await page.goto("/dashboard/swipe");
    const request = page.context().request;
    const share = "11111111-1111-4111-8111-111111111111";
    const savedPost = "22222222-2222-4222-8222-222222222222";
    const validPostUrl =
      "https://www.linkedin.com/feed/update/urn:li:activity:7340000000000000000";
    const responses = await Promise.all([
      request.get(`/api/saved-posts?share=${share}`),
      request.post(`/api/saved-posts?share=${share}`, {
        data: { url: validPostUrl, postType: "regular" },
      }),
      request.delete(`/api/saved-posts?share=${share}&id=${savedPost}`),
      request.post("/api/model-source", {
        data: { source: "bookmark", postId: savedPost, shareId: share },
      }),
    ]);
    const result = await Promise.all(
      responses.map(async (response) => ({
        status: response.status(),
        body: await response.json(),
      })),
    );

    expect(result.map((entry) => entry.status)).toEqual([404, 404, 404, 404]);
    for (const entry of result) {
      expect(entry.body.ok).toBe(false);
      expect(entry.body).not.toHaveProperty("cards");
      expect(entry.body).not.toHaveProperty("saved");
    }
  });

  test("an accepted recipient can remove only their own shared-library contribution", async ({
    page,
  }) => {
    await page.goto("/dashboard/swipe");
    const fixtureId = crypto.randomUUID();
    const ownerWorkspaceId = `e2e_shared_${fixtureId}`;
    const recipientEmail = process.env.E2E_CLERK_USER_EMAIL;
    expect(recipientEmail).toBeTruthy();
    const insertedShares = await adminRest<Array<{ id: string }>>(
      "shared_bookmarks",
      "POST",
      {
        owner_workspace_id: ownerWorkspaceId,
        recipient_email: recipientEmail!.toLowerCase(),
        recipient_user_id: null,
        status: "pending",
      },
    );
    const shareId = insertedShares[0]!.id;
    sharesToDelete.push(shareId);

    // Exercise the real invite-resolution and acceptance path. GET binds the
    // verified primary email to this Clerk user; PATCH turns the pending share
    // into an accepted library.
    const resolved = await page.context().request.get("/api/shared-bookmarks");
    expect(resolved.status()).toBe(200);
    const accepted = await page.context().request.patch(
      `/api/shared-bookmarks/${shareId}`,
      { data: { action: "accept" } },
    );
    expect(accepted.status()).toBe(200);
    const acceptedRows = await adminRest<Array<{ recipient_user_id: string }>>(
      "shared_bookmarks",
      "GET",
      undefined,
      `id=eq.${shareId}&select=recipient_user_id`,
    );
    const recipientUserId = acceptedRows[0]!.recipient_user_id;
    expect(recipientUserId).toBeTruthy();

    const ownerBookmarkId = crypto.randomUUID();
    const recipientBookmarkId = crypto.randomUUID();
    const rows = [
      sharedBookmarkFixture({
        id: ownerBookmarkId,
        workspaceId: ownerWorkspaceId,
        activityId: `owner-${fixtureId}`,
        authorName: "Owner Fixture",
        createdByUserId: "owner-user",
      }),
      sharedBookmarkFixture({
        id: recipientBookmarkId,
        workspaceId: ownerWorkspaceId,
        activityId: `recipient-${fixtureId}`,
        authorName: "Recipient Fixture",
        createdByUserId: recipientUserId!,
      }),
    ];
    await adminRest("saved_posts", "POST", rows);
    directBookmarksToDelete.push(ownerBookmarkId, recipientBookmarkId);

    await page.goto(`/dashboard/swipe?tab=bookmarks&share=${shareId}`);
    const ownerCard = page.locator(`#saved-${ownerBookmarkId}`).filter({ visible: true });
    const recipientCard = page
      .locator(`#saved-${recipientBookmarkId}`)
      .filter({ visible: true });
    await expect(ownerCard).toHaveCount(1);
    await expect(recipientCard).toHaveCount(1);
    await expect(ownerCard).toBeVisible();
    await expect(recipientCard).toBeVisible();

    const denied = await page.context().request.delete(
      `/api/saved-posts?share=${shareId}&id=${ownerBookmarkId}`,
    );
    expect(denied.status()).toBe(403);
    await expect(ownerCard).toBeVisible();

    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).searchParams.get("id") === recipientBookmarkId,
    );
    page.once("dialog", (dialog) => dialog.accept());
    await recipientCard.getByRole("button", { name: "Remove saved post" }).click();
    expect((await removed).status()).toBe(200);
    await expect(recipientCard).toHaveCount(0);
    directBookmarksToDelete.splice(
      directBookmarksToDelete.indexOf(recipientBookmarkId),
      1,
    );
  });

  test("bare navigation restores persisted Swipe File and Bookmark filters", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.evaluate(() => {
      sessionStorage.setItem(
        "swipein:filters:swipe",
        "type=lead_magnet&sort=comments&minC=10",
      );
      sessionStorage.setItem(
        "swipein:filters:bookmarks",
        "type=regular&sort=reactions",
      );
    });

    await clickUniqueNavigationLink(page, "Swipe File");
    await expect(page).toHaveURL(/\/dashboard\/swipe\?type=lead_magnet&sort=comments&minC=10$/);
    const bookmarksTab = page.getByRole("link", { name: /Bookmarks saved source posts/i });
    await expect(bookmarksTab).toHaveCount(1);
    await bookmarksTab.click();
    await expect(page).toHaveURL(
      /\/dashboard\/swipe\?tab=bookmarks&type=regular&sort=reactions$/,
    );
  });
});

async function clickUniqueNavigationLink(page: Page, name: string) {
  const links = page.getByRole("link", { name, exact: true });
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
  const visible = links.filter({ visible: true });
  await expect(visible).toHaveCount(1);
  await visible.click();
}

function sharedBookmarkFixture({
  id,
  workspaceId,
  activityId,
  authorName,
  createdByUserId,
}: {
  id: string;
  workspaceId: string;
  activityId: string;
  authorName: string;
  createdByUserId: string;
}) {
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}`;
  return {
    id,
    workspace_id: workspaceId,
    activity_id: activityId,
    post_url: postUrl,
    original_url: postUrl,
    author_name: authorName,
    text: `${authorName} shared-library fixture text.`,
    text_snippet: `${authorName} shared-library fixture text.`,
    media_type: "none",
    media_urls: [],
    post_type: "regular",
    created_by_user_id: createdByUserId,
    saved_by: createdByUserId,
  };
}

async function adminRest<T = unknown>(
  table: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  query = "",
): Promise<T> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase E2E credentials are missing");
  const response = await fetch(
    `${url}/rest/v1/${table}${query ? `?${query}` : ""}`,
    {
      method,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: method === "POST" ? "return=representation" : "return=minimal",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`E2E fixture ${method} ${table} failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
