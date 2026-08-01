import { test, expect } from "@playwright/test";

// Visual-verification suite: signs in (via the storageState from global.setup)
// and screenshots the key authed screens into e2e/screenshots/ for review.
// Run with `npm run e2e`. These are NOT strict assertions of pixels — they
// capture the real rendered UI so a human (or the agent) can eyeball changes
// like the posts board, which can't be verified by typecheck alone.

const SHOTS: { path: string; name: string; ready: RegExp }[] = [
  { path: "/dashboard/posts", name: "posts-board", ready: /posts/i },
  { path: "/dashboard", name: "dashboard-home", ready: /./ },
  { path: "/dashboard/swipe", name: "swipe-file", ready: /./ },
  { path: "/dashboard/voice", name: "voice", ready: /./ },
  { path: "/dashboard/agent", name: "agent", ready: /your agent/i },
  { path: "/dashboard/analytics", name: "analytics", ready: /analytics/i },
];

for (const s of SHOTS) {
  test(`screenshot ${s.name}`, async ({ page }) => {
    await page.goto(s.path);
    // Wait for the app shell to render (not a Clerk redirect / error).
    await expect(page).toHaveURL(new RegExp(s.path.replace(/\//g, "\\/")));
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: `e2e/screenshots/${s.name}.png`,
      fullPage: true,
    });
  });
}

// A focused assertion that the posts board actually rendered its columns —
// proves the page isn't just a blank shell or an auth wall. The column label
// appears in BOTH the desktop grid header and the (hidden on desktop) mobile
// tab strip, so we assert at least one VISIBLE instance per label rather than
// .first() (which can resolve to the hidden mobile button).
test("posts board shows the pipeline columns", async ({ page }) => {
  await page.goto("/dashboard/posts");
  await expect(page.getByRole("heading", { name: /posts/i })).toBeVisible();
  for (const col of ["Idea", "Draft", "Ready", "Scheduled", "Posted"]) {
    await expect(
      page.locator(`text=${col}`).locator("visible=true").first(),
    ).toBeVisible();
  }
});
