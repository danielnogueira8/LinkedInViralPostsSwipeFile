import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes — everything else (e.g. /dashboard/*) requires a Clerk session.
const isPublicRoute = createRouteMatcher([
  // Marketing site
  "/",
  "/pricing",
  "/features",
  "/privacy",
  "/terms",
  // MCP discovery + bearer-token auth (handled by withMcpAuth, not Clerk session)
  "/.well-known/oauth-authorization-server(.*)",
  "/.well-known/oauth-protected-resource(.*)",
  "/api/mcp(.*)",
  // Cron jobs authenticate via CRON_SECRET header, not Clerk session
  "/api/cron(.*)",
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
