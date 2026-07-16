import { NextResponse } from "next/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import {
  getConnection,
  ensureProfile,
  markDisconnected,
  canPublish,
} from "@/lib/publishing";
import { getConnectUrl, deleteAccount } from "@/lib/zernio";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// The workspace's LinkedIn publishing connection (via Zernio).
//   GET    → connection status for the Settings card + the schedule gate.
//   POST   → start the hosted OAuth flow; returns { authUrl } to redirect to.
//   DELETE → disconnect (best-effort on Zernio's side + mark our row).
// All workspace-scoped; the Zernio account id is resolved from the workspace,
// never client input.
// -----------------------------------------------------------------------------

export async function GET() {
  try {
    const workspaceId = await requireWorkspaceId();
    const conn = await getConnection(workspaceId);
    return NextResponse.json({
      ok: true,
      connection: conn
        ? {
            status: conn.status,
            connected: canPublish(conn),
            displayName: conn.display_name,
            avatarUrl: conn.avatar_url,
            disconnectedReason: conn.disconnected_reason,
          }
        : null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// Build the absolute origin from the request (Vercel sets x-forwarded-*). Used
// for the OAuth redirectUrl — no APP_URL env var exists in this app.
function originFrom(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  try {
    const workspaceId = await requireWorkspaceId();
    // Already connected? Don't re-initiate. Zernio's /connect rejects starting a
    // new OAuth flow on a profile that already has an active LinkedIn account
    // (a 400 that used to surface as a nonsensical "Publishing failed" toast on
    // the CONNECT screen). Short-circuit with a clear signal the client can act
    // on (e.g. skip the onboarding step / show "Connected").
    const existing = await getConnection(workspaceId);
    if (canPublish(existing)) {
      return NextResponse.json({
        ok: true,
        alreadyConnected: true,
        displayName: existing?.display_name ?? null,
      });
    }
    // Ensure the workspace has a Zernio profile (created once, reused), then
    // get the hosted auth URL pointing back at our finalize callback.
    const profileId = await ensureProfile(workspaceId);
    // Where to land the browser after OAuth. Zernio has no state-passthrough,
    // so we carry the return target IN the redirectUrl itself — Zernio redirects
    // to exactly this URL, so ?returnTo survives the round-trip and finalize
    // reads it back. Allow-list only "welcome" (the onboarding wizard); anything
    // else defaults to Settings. Never reflect an arbitrary target.
    const returnTo = new URL(req.url).searchParams.get("returnTo") === "welcome" ? "welcome" : "";
    const redirectUrl =
      `${originFrom(req)}/api/integrations/linkedin/finalize` +
      (returnTo ? `?returnTo=${returnTo}` : "");
    const authUrl = await getConnectUrl({ platform: "linkedin", profileId, redirectUrl });
    return NextResponse.json({ ok: true, authUrl });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE() {
  try {
    const workspaceId = await requireWorkspaceId();
    const conn = await getConnection(workspaceId);
    // Best-effort disconnect on Zernio's side; we mark our row regardless so the
    // Settings card reflects the user's intent even if the remote call fails.
    if (conn?.zernio_account_id) await deleteAccount(conn.zernio_account_id);
    await markDisconnected(workspaceId, "Disconnected by user");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
