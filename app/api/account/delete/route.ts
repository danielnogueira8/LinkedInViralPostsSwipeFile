import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { purgeWorkspaceData } from "@/lib/purge-workspace";
import { resolvePersonalWorkspaceForUser } from "@/lib/personal-workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// POST /api/account/delete — self-serve GDPR erasure of the caller's workspace.
//
// The privacy policy promises deletion within 30 days of a verified request;
// this makes it self-serve and immediate. Purges every table of this
// workspace's data (see purgeWorkspaceData), then deletes the Clerk
// organization so nothing is left dangling.
//
// Guards:
//   • Auth required (Clerk session; also enforced by proxy.ts).
//   • The caller must OWN this workspace — it must be a personal org they
//     created (org.createdBy === userId). We refuse to let a mere member wipe a
//     shared org's data out from under other members.
//   • An explicit { confirm: "DELETE" } body, so a stray POST can't erase an
//     account. The UI sends this after a typed confirmation.
// -----------------------------------------------------------------------------
type Body = { confirm?: string };

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    if (body.confirm !== "DELETE") {
      return NextResponse.json(
        { ok: false, error: 'Confirmation required. Send { "confirm": "DELETE" }.' },
        { status: 400 },
      );
    }

    // Resolve ownership server-side. The active organization is deliberately
    // ignored so a stale/foreign session can never choose what gets erased.
    const client = await clerkClient();
    const workspaceId = await resolvePersonalWorkspaceForUser(userId);

    // 1. Purge all of this workspace's data from the database.
    const purge = await purgeWorkspaceData(workspaceId, userId);
    // Log the erasure outcome (grep `workspace_purged`) — an operator can prove
    // a GDPR request was fulfilled, and a partial failure is visible.
    console.log(
      JSON.stringify({
        workspace_purged: {
          workspace_id: workspaceId,
          user_id: userId,
          ok: purge.ok,
          deleted: purge.deleted,
          errors: purge.errors,
        },
      }),
    );
    if (!purge.ok) {
      // Some table(s) failed — do NOT delete the Clerk org, so the user can
      // retry and we don't orphan a half-purged workspace behind a deleted org.
      return NextResponse.json(
        {
          ok: false,
          error:
            "We couldn't fully delete your data just now. Nothing was removed from your account access — please try again, or email us and we'll complete it.",
          details: purge.errors,
        },
        { status: 500 },
      );
    }

    // 2. Delete the Clerk organization (the workspace itself). The user's Clerk
    //    identity remains — deleting their login is a separate action they take
    //    in the account menu; a user.deleted webhook then re-purges as a
    //    backstop. Best-effort: the data (the GDPR-relevant part) is already
    //    gone; if the org delete blips, log it but still report success.
    try {
      await client.organizations.deleteOrganization(workspaceId);
    } catch (e) {
      console.error(
        JSON.stringify({
          workspace_purged_org_delete_failed: {
            workspace_id: workspaceId,
            error: (e as Error).message,
          },
        }),
      );
    }

    return NextResponse.json({ ok: true, deleted: purge.deleted });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
