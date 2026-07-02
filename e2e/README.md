# E2E / visual verification (Playwright + Clerk)

Renders the **real** app — including authed `/dashboard/*` pages — in headless
Chromium so changes can be eyeballed via screenshots, not just typecheck. Uses
[`@clerk/testing`](https://clerk.com/docs/guides/development/testing/playwright/overview)
to sign in programmatically (no UI, no Clerk hosted-domain redirect).

## One-time setup

Add these to `.env.local` (gitignored — never commit them):

```
# Clerk test keys — already present for the app (pk_test_* / sk_test_*).
# @clerk/testing reads CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY; the app uses
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY. Alias the publishable one:
CLERK_PUBLISHABLE_KEY=pk_test_...        # same value as NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

# The email of a real user in this Clerk instance. NO password needed.
E2E_CLERK_USER_EMAIL=you@example.com
```

`CLERK_SECRET_KEY` is already in `.env.local`. `clerkSetup()` auto-generates the
testing token from the secret key, so no separate `CLERK_TESTING_TOKEN` is
needed.

> **Magic-link / passwordless instances are fully supported.** We sign in with
> the EMAIL-ONLY strategy (`clerk.signIn({ page, emailAddress })`), which mints a
> session via Clerk's Backend API (using `CLERK_SECRET_KEY`) — **no password and
> no magic-link click.** It "works regardless of your instance's verification or
> MFA settings." Tip: a `+clerk_test` email (e.g. `you+clerk_test@example.com`)
> is treated as a test user and suppresses email delivery, but any real user's
> email works for the Backend-API session mint.

## Run

```bash
npm run e2e            # boots `next dev`, signs in, screenshots + asserts
npm run e2e -- --ui   # interactive runner
```

Screenshots land in `e2e/screenshots/`; an HTML report in `e2e/.report/`. Both
are gitignored.

## What it does

- `global.setup.ts` — `clerkSetup()` + programmatic password sign-in → saves the
  session to `e2e/.clerk/user.json` (storageState). The app's DashboardLayout
  auto-activates the user's own org, so no org-switch step is needed.
- `smoke.spec.ts` — reuses that session and makes HARD ASSERTIONS that each key
  authed page renders its real content (a heading, a primary action, the
  templates library + its filter). These FAIL on a broken render — the class of
  regression typecheck can't catch (a page that compiles but throws at runtime,
  a component that renders nothing, a data-shape mismatch that empties a list).
  Deliberately shallow: one or two stable anchors per page, never brittle copy.
- `screenshots.spec.ts` — reuses that session, visits the key screens, and saves
  full-page screenshots; plus a real assertion that the drafts board renders its
  four pipeline columns.

Run just the smoke assertions (fast, no screenshots): `npm run e2e:smoke`.
