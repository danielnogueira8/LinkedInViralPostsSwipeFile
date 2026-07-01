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
      // each. The user is already gone from Clerk, so we look up by createdBy —
      // and getOrganizationList has no createdBy filter, so we PAGINATE the full
      // org list and filter client-side. A bare limit:100 (the old code)
      // silently skipped a deleted user whose org fell past the first page once
      // the platform exceeds 100 orgs — a silent GDPR-erasure gap.
      const client = await clerkClient();
      const PAGE = 100;
      const MAX_PAGES = 200; // 20k orgs — defensive ceiling so we can't loop forever
      const owned: string[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await client.organizations.getOrganizationList({
          limit: PAGE,
          offset: page * PAGE,
        });
        for (const o of res.data) {
          if (o.createdBy === userId) owned.push(o.id);
        }
        if (res.data.length < PAGE) break; // last page reached
      }
      for (const orgId of owned) {
        await purgeAndLog(orgId, userId, "user.deleted");
        // Also delete the now-ownerless org so it doesn't linger.
        try {
          await client.organizations.deleteOrganization(orgId);
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
