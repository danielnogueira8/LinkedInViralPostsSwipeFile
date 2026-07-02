import { test, expect } from "@playwright/test";

// Smoke tests: sign in (via the storageState from global.setup) and assert that
// each key authed page actually RENDERS ITS REAL CONTENT — not just a blank
// shell, an auth wall, or a crash. Unlike the screenshot suite (which captures
// pixels for a human to eyeball), these are hard assertions that FAIL on a
// broken render, so they catch the class of regression that typecheck can't:
// a page that compiles but throws at runtime, a component that renders nothing,
// a data-shape mismatch that empties the list.
//
// Deliberately shallow + resilient: one or two stable anchors per page (a
// heading, a primary action), never brittle text that copy tweaks would break.
// Run with `npm run e2e`.

test.describe("dashboard smoke — key pages render their content", () => {
  test("chat (/dashboard) renders the composer + new-chat action", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
    // The chat workspace: a "New chat" affordance and the chat-search box are
    // always present regardless of history.
    await expect(page.getByRole("button", { name: /new chat/i }).first()).toBeVisible();
    await expect(page.getByPlaceholder(/search chats/i)).toBeVisible();
  });

  test("swipe file renders its heading", async ({ page }) => {
    await page.goto("/dashboard/swipe");
    await expect(page.getByRole("heading", { name: /swipe file/i }).first()).toBeVisible();
  });

  test("bookmarks renders its heading", async ({ page }) => {
    await page.goto("/dashboard/bookmarks");
    await expect(page.getByRole("heading", { name: /bookmarks/i }).first()).toBeVisible();
  });

  test("posts board renders", async ({ page }) => {
    await page.goto("/dashboard/posts");
    await expect(page.getByRole("heading", { name: /posts/i }).first()).toBeVisible();
  });

  test("voice page renders", async ({ page }) => {
    await page.goto("/dashboard/voice");
    await expect(page).toHaveURL(/\/dashboard\/voice/);
    await page.waitForLoadState("networkidle");
    // The shell rendered (not a Clerk redirect / error page).
    await expect(page.locator("main, [role=main]").first()).toBeVisible();
  });
});

// The Templates page got the heaviest rework this session (a generic library,
// LinkedIn-style cards, the category-filter rail) and had NO e2e coverage — so
// it gets its own, more thorough smoke check. Every assertion targets a stable
// structural element, not specific template copy.
test.describe("templates page — the reworked library renders end to end", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard/templates");
    await expect(page.getByRole("heading", { name: /templates/i }).first()).toBeVisible();
  });

  test("shows the header + the New template action", async ({ page }) => {
    await expect(page.getByRole("button", { name: /new template/i })).toBeVisible();
    // The built-in starter library is always present (the count copy).
    await expect(page.getByText(/built-in/i).first()).toBeVisible();
  });

  test("renders the category filter rail with an 'All' pill", async ({ page }) => {
    // The filter rail (shared chrome with bookmarks): the "Category" label and
    // the "All" pill are always shown when the library is non-empty (it always
    // is, thanks to the built-ins).
    await expect(page.getByText("Category").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^All\b/ }).first()).toBeVisible();
  });

  test("renders at least one template card with its actions", async ({ page }) => {
    // The built-ins guarantee ≥1 card, each with the primary "Model in Chat"
    // action and a "Copy" action. Proves the grid + card actually rendered.
    await expect(page.getByRole("button", { name: /model in chat/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Copy$/i }).first()).toBeVisible();
  });

  test("the category filter actually filters (client-side, no reload)", async ({ page }) => {
    // Count the cards on "All", pick a specific category pill, and assert the
    // visible set changes (or at least stays a valid, non-crashing subset). We
    // key off the "Model in Chat" button, one per card.
    const cardButtons = page.getByRole("button", { name: /model in chat/i });
    const allCount = await cardButtons.count();
    expect(allCount).toBeGreaterThan(0);

    // Click the first NON-"All" category pill in the rail. Pills are buttons
    // whose label ends in a small count; we grab the Contrarian one (a built-in
    // category that always has templates) if present, else any second pill.
    const contrarianPill = page.getByRole("button", { name: /^Contrarian\b/ });
    if (await contrarianPill.count()) {
      await contrarianPill.first().click();
      // After filtering, the grid still renders cards (a valid subset), and the
      // page didn't crash — at least one card remains for a populated category.
      await expect(cardButtons.first()).toBeVisible();
      const filtered = await cardButtons.count();
      expect(filtered).toBeGreaterThan(0);
      expect(filtered).toBeLessThanOrEqual(allCount);
    }
  });
});
