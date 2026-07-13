import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes — everything else (e.g. /dashboard/*) requires a Clerk session.
const isPublicRoute = createRouteMatcher([
  // Marketing site — use (.*) suffixes so bogus paths under a public route
  // (e.g. /terms/typo) actually reach the not-found page instead of being
  // sent to sign-in first.
  "/",
  "/pricing(.*)",
  "/features(.*)",
  "/privacy(.*)",
  "/terms(.*)",
  // Public AI usage guide generated from the current MCP tool catalog
  "/llms.txt",
  // Public lead magnet pages shared by creators
  "/lm(.*)",
  // MCP discovery + bearer-token auth (handled by withMcpAuth, not Clerk session)
  "/.well-known/oauth-authorization-server(.*)",
  "/.well-known/oauth-protected-resource(.*)",
  "/api/mcp(.*)",
  // Cron jobs authenticate via CRON_SECRET header, not Clerk session
  "/api/cron(.*)",
  // Public liveness check for uptime monitors (no session; touches no tenant data)
  "/api/health",
  // Same-origin Sentry envelope tunnel; contains only SDK telemetry and must
  // accept reports from public pages before a Clerk session exists.
  "/monitoring(.*)",
  // Clerk webhooks (GDPR-erasure backstop) — auth is the Svix signature, not a session
  "/api/webhooks(.*)",
  // Clerk's own sign-in/sign-up flows
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
