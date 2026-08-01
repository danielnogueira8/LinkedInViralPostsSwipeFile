import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { purgeWorkspaceData } from "@/lib/purge-workspace";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// POST /api/account/delete — self-serve GDPR erasure of the caller's workspace.
//
// The privacy policy promises deletion within 30 days of a verified request;
// this makes it self-serve and immediate. workspace_id == the Clerk user id
// (1 user = 1 workspace), so the caller always owns their own workspace — the
// old org-ownership check + org delete are gone. Purges every table of this
// workspace's data (see purgeWorkspaceData); the user's Clerk login remains
// (deleting it is a separate action in the account menu, and a user.deleted
// webhook re-purges as a backstop).
//
// Guards:
//   • Auth required (Clerk session; also enforced by proxy.ts).
//   • An explicit { confirm: "DELETE" } body, so a stray POST can't erase an
//     account. The UI sends this after a typed confirmation.
// -----------------------------------------------------------------------------
type Body = { confirm?: string };
const bodySchema = z.object({ confirm: z.string().optional() });

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    const body = parsed.success ? (parsed.data as Body) : {};
    if (body.confirm !== "DELETE") {
      return NextResponse.json(
        { ok: false, error: 'Confirmation required. Send { "confirm": "DELETE" }.' },
        { status: 400 },
      );
    }

    // Purge all of this workspace's data from the database (workspace_id == userId).
    const purge = await purgeWorkspaceData(userId, userId);
    // Log the erasure outcome (grep `workspace_purged`) — an operator can prove
    // a GDPR request was fulfilled, and a partial failure is visible.
    console.log(
      JSON.stringify({
        workspace_purged: {
          workspace_id: userId,
          user_id: userId,
          ok: purge.ok,
          deleted: purge.deleted,
          errors: purge.errors,
        },
      }),
    );
    if (!purge.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "We couldn't fully delete your data just now. Nothing was removed from your account access — please try again, or email us and we'll complete it.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, deleted: purge.deleted });
  } catch (e) {
    return errorResponse(e);
  }
}
