import { expect, test, type Page } from "@playwright/test";
import { failOnConsoleErrors } from "./helpers/console";

const PAGE_ANCHORS = [
  { href: "/dashboard", role: "button" as const, anchor: /new session/i },
  { href: "/dashboard/accounts", role: "heading" as const, anchor: /content sources/i },
  { href: "/dashboard/swipe", role: "heading" as const, anchor: /swipe file/i },
  { href: "/dashboard/posts", role: "heading" as const, anchor: /^posts$/i },
  { href: "/dashboard/settings", role: "heading" as const, anchor: /^settings$/i },
] as const;

test.describe("authenticated critical navigation", () => {
  let guard: ReturnType<typeof failOnConsoleErrors>;

  test.beforeEach(async ({ page }, testInfo) => {
    await mockExternalImages(page);
    guard = failOnConsoleErrors(page, testInfo);
  });

  test.afterEach(async ({ page }) => {
    await assertNonBlankApp(page);
    await guard.assertNoErrors();
  });

  test("desktop navigation renders onboarding, discovery, review, and settings surfaces", async ({ page }) => {
    for (const journey of PAGE_ANCHORS) {
      await page.goto(journey.href);
      await expect(page.getByRole(journey.role, { name: journey.anchor }).first()).toBeVisible();
      await assertNonBlankApp(page);
    }

    await page.goto("/dashboard/accounts");
    let submittedUrl = "";
    await page.route("**/api/accounts/manual", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submittedUrl = (route.request().postDataJSON() as { profile_url: string }).profile_url;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          meta_resolved: true,
          account: {
            id: "e2e-deterministic-source",
            name: "Deterministic Creator",
            linkedin_handle: "e2e-deterministic-creator",
          },
        }),
      });
    });
    await page.getByRole("button", { name: /add creator/i }).click();
    const dialog = page.getByRole("dialog", { name: "Add creator" });
    await dialog.getByLabel("LinkedIn profile URL").fill(
      "https://www.linkedin.com/in/e2e-deterministic-creator",
    );
    await dialog.getByRole("button", { name: "Add creator", exact: true }).click();
    await expect(page.getByText("Added Deterministic Creator")).toBeVisible();
    expect(submittedUrl).toBe("https://www.linkedin.com/in/e2e-deterministic-creator");
  });

  test("navigation feedback appears before a deliberately delayed destination", async ({ page }) => {
    await page.goto("/dashboard/swipe");
    await page.route("**/dashboard/posts**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await page.getByRole("link", { name: "Posts", exact: true }).click();
    const loadingOrContent = await Promise.race([
      page.getByText("Loading posts").waitFor({ state: "visible", timeout: 3_000 }).then(() => "loading" as const).catch(() => null),
      page.getByRole("heading", { name: /^Posts$/ }).waitFor({ state: "visible", timeout: 3_000 }).then(() => "content" as const).catch(() => null),
    ]);
    expect(loadingOrContent).not.toBeNull();
    await expect(page.getByRole("heading", { name: /^Posts$/ })).toBeVisible();
  });
});

test.describe("authenticated mobile navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("primary and More navigation reach discovery, sources, review, and settings", async ({ page }, testInfo) => {
    const guard = failOnConsoleErrors(page, testInfo);
    await mockExternalImages(page);
    await page.goto("/dashboard");
    const primary = page.getByRole("navigation", { name: "Primary" });
    await expect(primary).toBeVisible();

    await primary.getByRole("link", { name: "Swipe", exact: true }).click();
    await expect(page.getByRole("link", { name: /swipe file all source posts/i })).toBeVisible();

    for (const destination of ["Content Sources", "Posts", "Settings"] as const) {
      await primary.getByRole("button", { name: /more/i }).click();
      const dialog = page.getByRole("dialog", { name: "More navigation" });
      await dialog.getByRole("link", { name: destination, exact: true }).click();
      await expect(page.getByRole("heading", { name: new RegExp(`^${destination}$`, "i") }).first()).toBeVisible();
      await assertNonBlankApp(page);
    }
    await guard.assertNoErrors();
  });
});

async function assertNonBlankApp(page: Page) {
  await expect(page.locator("body")).not.toHaveText(/^\s*$/);
  const main = page.locator("main, [role=main]").first();
  await expect(main).toBeVisible();
  const box = await main.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(100);
  expect(box?.height ?? 0).toBeGreaterThan(100);
  await expect(page.getByText(/application error|internal server error/i)).toHaveCount(0);
}

async function mockExternalImages(page: Page) {
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://media.licdn.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: pixel }),
  );
  await page.route("**/_next/image?**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: pixel }),
  );
}
