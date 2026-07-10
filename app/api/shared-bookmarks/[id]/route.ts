import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { verifiedPrimaryEmail } from "@/lib/shared-bookmarks";

export const runtime = "nodejs";

type PatchBody = {
  // "accept" or "decline" are recipient actions; "revoke" is the owner.
  action?: "accept" | "decline" | "revoke";
};

// -----------------------------------------------------------------------------
// PATCH /api/shared-bookmarks/:id  — accept, decline, or revoke an invite
//
// Authorization is action-dependent:
//   - revoke  → must be the owner workspace
//   - accept  → must be the recipient (resolved by user_id OR email)
//   - decline → must be the recipient
//
// Decline marks the row 'declined' (keeps the audit trail). Revoke marks
// 'revoked'. Both free up the unique constraint so the owner can re-invite.
// -----------------------------------------------------------------------------
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as PatchBody;
    const action = body.action;
    if (!action || !["accept", "decline", "revoke"].includes(action)) {
      return NextResponse.json(
        { ok: false, error: "action must be accept | decline | revoke" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const { userId } = await auth();

    const { data: share, error: fetchErr } = await sb.raw
      .from("shared_bookmarks")
      .select("id, owner_workspace_id, recipient_user_id, recipient_email, status")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    // Don't leak existence for non-owners / non-recipients — 404 either way.
    if (!share) {
      return NextResponse.json({ ok: false, error: "Share not found" }, { status: 404 });
    }

    if (action === "revoke") {
      if (share.owner_workspace_id !== sb.workspaceId) {
        return NextResponse.json({ ok: false, error: "Share not found" }, { status: 404 });
      }
      const { data: updated, error } = await sb.raw
        .from("shared_bookmarks")
        .update({ status: "revoked", revoked_at: new Date().toISOString() })
        .eq("id", id)
        .eq("owner_workspace_id", sb.workspaceId)
        .eq("status", share.status)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!updated) return transitionConflict();
      return NextResponse.json({ ok: true });
    }

    // accept / decline must be the recipient
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Sign in first" }, { status: 401 });
    }
    if (share.recipient_user_id !== userId) {
      // Pending email invites may not be bound to a Clerk user yet. Resolve
      // them here too, so opening an invite link and accepting it directly
      // does not depend on a previous GET call having run first.
      if (share.status !== "pending" || share.recipient_user_id) {
        return NextResponse.json({ ok: false, error: "Share not found" }, { status: 404 });
      }
      const email = verifiedPrimaryEmail(await currentUser());
      if (!email || email !== share.recipient_email) {
        return NextResponse.json({ ok: false, error: "Share not found" }, { status: 404 });
      }
      const { data: resolved, error: resolveErr } = await sb.raw
        .from("shared_bookmarks")
        .update({ recipient_user_id: userId })
        .eq("id", id)
        .is("recipient_user_id", null)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (resolveErr) throw resolveErr;
      if (!resolved) {
        return NextResponse.json({ ok: false, error: "Share not found" }, { status: 404 });
      }
    }
    if (share.status !== "pending") {
      return NextResponse.json(
        { ok: false, error: `Cannot ${action} a ${share.status} share.` },
        { status: 400 },
      );
    }

    if (action === "accept") {
      const { data: updated, error } = await sb.raw
        .from("shared_bookmarks")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", id)
        .eq("recipient_user_id", userId)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!updated) return transitionConflict();
      return NextResponse.json({ ok: true });
    }
    // decline
    const { data: updated, error } = await sb.raw
      .from("shared_bookmarks")
      .update({ status: "declined" })
      .eq("id", id)
      .eq("recipient_user_id", userId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) return transitionConflict();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

function transitionConflict() {
  return NextResponse.json(
    { ok: false, error: "This invitation changed before your action completed. Refresh and try again." },
    { status: 409 },
  );
}
