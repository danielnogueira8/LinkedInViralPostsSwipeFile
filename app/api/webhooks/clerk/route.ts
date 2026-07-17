import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { purgeWorkspaceData } from "@/lib/purge-workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// POST /api/webhooks/clerk — GDPR-erasure backstop.
//
// When a user deletes their Clerk identity OUTSIDE our in-app flow, this webhook
// purges their workspace data so nothing is orphaned. workspace_id == the Clerk
// user id (1 user = 1 workspace), so a user.deleted event carries everything we
// need: the deleted user id IS the workspace to purge. (No orgs anymore — the
// old organization.deleted handler + the paginate-all-orgs-by-createdBy lookup
// are gone.)
//
// Verified with the Svix signature via verifyWebhook (CLERK_WEBHOOK_SIGNING_SECRET),
// so only genuine Clerk deliveries are processed. Public in proxy.ts (a webhook
// has no Clerk session); the signature IS the auth.
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
    if (evt.type === "user.deleted") {
      const userId = evt.data.id;
      if (!userId) return NextResponse.json({ ok: true });
      // The user id IS the workspace id — purge it directly.
      await purgeAndLog(userId, userId, "user.deleted");
      return NextResponse.json({ ok: true, purged: 1 });
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

  if (!purge.ok) {
    const failedTables = purge.errors.map(({ table }) => table).join(", ");
    throw new Error(`workspace purge incomplete: ${failedTables || "unknown table"}`);
  }
}
