import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Routes that should remain reachable without a Clerk session.
// Everything else (including the dashboard at "/") requires sign-in.
const isPublicRoute = createRouteMatcher([
  // MCP discovery + bearer-token auth (handled by withMcpAuth, not Clerk session)
  "/.well-known/oauth-authorization-server(.*)",
  "/.well-known/oauth-protected-resource(.*)",
  "/api/mcp(.*)",
  "/api/[transport](.*)",
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
