import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { finalizeConnection } from "@/lib/publishing";
import { getLinkedInOAuthDestination } from "@/lib/linkedin-integration-destination";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/integrations/linkedin/finalize — Zernio's hosted OAuth redirects the
// user's BROWSER here after they authorize. The callback doesn't carry the
// account id, so we reconcile via GET /v1/accounts (scoped to the workspace's
// Zernio profile) and write the connected account onto the row. Then we bounce
// the browser back to the initiating first-party surface with a status it reads.
//
// NOTE: LinkedIn's hosted flow may include a "select page/organization" step
// before landing here; for a personal-profile connect (v1) that resolves to a
// single account, which finalizeConnection() picks up from /v1/accounts. If a
// future org-picker step is needed, add it here (see docs connecting-accounts).
// -----------------------------------------------------------------------------
export async function GET(req: Request) {
  try {
    const workspaceId = await requireWorkspaceId();
    const ok = await finalizeConnection(workspaceId);
    const url = new URL(req.url);
    const origin = url.origin;
    const status = ok ? "connected" : "connect_failed";
    // Return the browser to wherever the connect flow was started from. The POST
    // route baked ?returnTo=welcome INTO this callback's own URL (Zernio has no
    // state passthrough), so onboarding returns to /welcome and Integrations
    // returns to its own card. Default: Settings. Allow-listed only — never
    // reflect an arbitrary target.
    const dest = getLinkedInOAuthDestination(url.searchParams.get("returnTo"));
    return Response.redirect(`${origin}${dest}?linkedin=${status}`, 302);
  } catch (e) {
    return errorResponse(e);
  }
}
