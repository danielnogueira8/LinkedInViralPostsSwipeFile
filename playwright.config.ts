import { defineConfig, devices } from "@playwright/test";

// Playwright E2E config for visually verifying the real app (authed pages) via
// @clerk/testing. Two projects:
//   - "setup": runs e2e/global.setup.ts once → clerkSetup() + a programmatic
//     sign-in, saving the authed session to e2e/.clerk/user.json (storageState).
//   - "chromium": the actual tests, which depend on "setup" and reuse that
//     storageState, so every test starts already signed in (no UI login).
//
// `webServer` auto-starts `next dev` and waits for it, so a single
// `npm run e2e` boots the app + runs the suite. Requires the Clerk test keys +
// E2E_CLERK_USER_EMAIL / E2E_CLERK_USER_PASSWORD in .env.local (see e2e/README).
const PORT = 3000;
const AUTH_FILE = "e2e/.clerk/user.json";

export default defineConfig({
  testDir: "./e2e",
  // Auth flows + a real dev server: keep it serial and patient.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { outputFolder: "e2e/.report", open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: AUTH_FILE },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run dev",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
