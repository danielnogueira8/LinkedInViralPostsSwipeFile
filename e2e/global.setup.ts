import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { test as setup, expect } from "@playwright/test";

// One-time auth setup (the "setup" project). clerkSetup() prepares the testing
// token (bypasses Clerk's bot/dev-browser detection — the redirect that blocks a
// headless run), then we sign in programmatically with the EMAIL-ONLY strategy
// and save the authed session so every real test reuses it.
//
// Email-only sign-in mints a session via Clerk's Backend API (using
// CLERK_SECRET_KEY), so it needs NO password and NO magic-link click — it
// "works regardless of your instance's verification or MFA settings." That's the
// path for a magic-link / passwordless instance like this one.
//
// The app's DashboardLayout auto-resolves the signed-in user's own org, so just
// signing in as the test user gives the right workspace context — no separate
// org-switch step needed.

setup.describe.configure({ mode: "serial" });

const AUTH_FILE = "e2e/.clerk/user.json";

setup("clerk setup", async () => {
  await clerkSetup();
  if (!process.env.E2E_CLERK_USER_EMAIL) {
    throw new Error(
      "E2E_CLERK_USER_EMAIL is not set. Add a test user's email to .env.local — see e2e/README.md.",
    );
  }
});

setup("authenticate and save state", async ({ page }) => {
  await page.goto("/");
  await clerk.signIn({
    page,
    emailAddress: process.env.E2E_CLERK_USER_EMAIL!,
  });
  // Land on a protected page to prove the session works before saving it.
  await page.goto("/dashboard/posts");
  await expect(page.getByRole("heading", { name: /posts/i })).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
