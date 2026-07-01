import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { clerkClient } from "@clerk/nextjs/server";
import { purgeWorkspaceData } from "@/lib/purge-workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// POST /api/webhooks/clerk — GDPR-erasure backstop.
//
// When a user deletes their Clerk identity (or an org is deleted) OUTSIDE our
// in-app flow, this webhook purges the corresponding workspace data so nothing
// is orphaned in the database. Without it, a user who removes their account via
// Clerk's own UI would leave all their chats/drafts/voice/bookmarks behind.
//
// Verified with the Svix signature via verifyWebhook (CLERK_WEBHOOK_SIGNING_SECRET),
// so only genuine Clerk deliveries are processed. Public in proxy.ts (a webhook
// has no Clerk session); the signature IS the auth.
//
// Handled events:
//   • organization.deleted — purge that workspace's data (workspace = org).
//   • user.deleted        — purge every personal org that user created, since
//                           Clerk may not emit organization.deleted for them.
// Everything else is acknowledged and ignored.
// -----------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch (e) {
    // Bad/absent signature — reject so Clerk retries (and randoms can't trigger it).
    console.error("clerk webhook verify failed", (e as Error).message);
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 400 });
  }

  try {
    if (evt.type === "organization.deleted") {
      const orgId = evt.data.id;
      if (orgId) await purgeAndLog(orgId, null, "organization.deleted");
      return NextResponse.json({ ok: true });
    }

    if (evt.type === "user.deleted") {
      const userId = evt.data.id;
      if (!userId) return NextResponse.json({ ok: true });
      // Find every org this user created (their personal workspaces) and purge
      // each. The user is already gone from Clerk, so we look up by createdBy.
      const client = await clerkClient();
      const orgs = await client.organizations.getOrganizationList({ limit: 100 });
      const owned = orgs.data.filter((o) => o.createdBy === userId);
      for (const o of owned) {
        await purgeAndLog(o.id, userId, "user.deleted");
        // Also delete the now-ownerless org so it doesn't linger.
        try {
          await client.organizations.deleteOrganization(o.id);
        } catch {
          // Best-effort — the data is what matters for GDPR.
        }
      }
      return NextResponse.json({ ok: true, purged: owned.length });
    }

    // Unhandled event type — ack so Clerk doesn't retry.
    return NextResponse.json({ ok: true, ignored: evt.type });
  } catch (e) {
    // Return 500 so Clerk retries — better than silently dropping an erasure.
    console.error("clerk webhook handler error", (e as Error).message);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

async function purgeAndLog(
  workspaceId: string,
  userId: string | null,
  source: string,
): Promise<void> {
  const purge = await purgeWorkspaceData(workspaceId, userId);
  console.log(
    JSON.stringify({
      workspace_purged: {
        source,
        workspace_id: workspaceId,
        user_id: userId,
        ok: purge.ok,
        deleted: purge.deleted,
        errors: purge.errors,
      },
    }),
  );
}
