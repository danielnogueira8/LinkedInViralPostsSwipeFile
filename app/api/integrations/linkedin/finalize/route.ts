import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { finalizeConnection } from "@/lib/publishing";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/integrations/linkedin/finalize — Zernio's hosted OAuth redirects the
// user's BROWSER here after they authorize. The callback doesn't carry the
// account id, so we reconcile via GET /v1/accounts (scoped to the workspace's
// Zernio profile) and write the connected account onto the row. Then we bounce
// the browser back to Settings with a status the card reads.
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
    const origin = new URL(req.url).origin;
    const status = ok ? "connected" : "connect_failed";
    return Response.redirect(`${origin}/dashboard/settings?linkedin=${status}`, 302);
  } catch (e) {
    return errorResponse(e);
  }
}
