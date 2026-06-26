import { test, expect } from "@playwright/test";

// Visual-verification suite: signs in (via the storageState from global.setup)
// and screenshots the key authed screens into e2e/screenshots/ for review.
// Run with `npm run e2e`. These are NOT strict assertions of pixels — they
// capture the real rendered UI so a human (or the agent) can eyeball changes
// like the drafts board, which can't be verified by typecheck alone.

const SHOTS: { path: string; name: string; ready: RegExp }[] = [
  { path: "/dashboard/drafts", name: "drafts-board", ready: /drafts/i },
  { path: "/dashboard", name: "dashboard-home", ready: /./ },
  { path: "/dashboard/swipe", name: "swipe-file", ready: /./ },
  { path: "/dashboard/voice", name: "voice", ready: /./ },
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

// A focused assertion that the drafts board actually rendered its columns —
// proves the page isn't just a blank shell or an auth wall. The column label
// appears in BOTH the desktop grid header and the (hidden on desktop) mobile
// tab strip, so we assert at least one VISIBLE instance per label rather than
// .first() (which can resolve to the hidden mobile button).
test("drafts board shows the pipeline columns", async ({ page }) => {
  await page.goto("/dashboard/drafts");
  await expect(page.getByRole("heading", { name: /drafts/i })).toBeVisible();
  for (const col of ["Ideas & hooks", "Drafting", "Ready", "Posted"]) {
    await expect(
      page.locator(`text=${col}`).locator("visible=true").first(),
    ).toBeVisible();
  }
});
