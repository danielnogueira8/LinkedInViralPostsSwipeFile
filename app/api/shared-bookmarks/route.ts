import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";

export const runtime = "nodejs";

type CreateBody = {
  recipient_email?: string;
};

// -----------------------------------------------------------------------------
// GET /api/shared-bookmarks
//
// Returns:
//   outgoing  — shares this workspace has issued (any status)
//   incoming  — shares addressed to the calling user (pending or accepted)
//
// Pending invites are resolved by email at sign-in: if the user has a
// pending row whose recipient_email matches their primary email and
// recipient_user_id is still null, we populate user_id here so future
// lookups can use it.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { userId } = await auth();
    const user = await currentUser();
    const email =
      user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? null;

    // Resolve email-based pending invites to this user. Cheap — only
    // runs against pending rows for the user's email.
    if (userId && email) {
      await sb.raw
        .from("shared_bookmarks")
        .update({ recipient_user_id: userId })
        .eq("recipient_email", email.toLowerCase())
        .eq("status", "pending")
        .is("recipient_user_id", null);
    }

    const [outgoingRes, incomingRes] = await Promise.all([
      sb.raw
        .from("shared_bookmarks")
        .select("id, recipient_email, recipient_user_id, status, created_at, accepted_at")
        .eq("owner_workspace_id", sb.workspaceId)
        .order("created_at", { ascending: false }),
      userId
        ? sb.raw
            .from("shared_bookmarks")
            .select("id, owner_workspace_id, status, created_at, accepted_at")
            .eq("recipient_user_id", userId)
            .in("status", ["pending", "accepted"])
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as unknown[], error: null }),
    ]);

    if (outgoingRes.error) throw outgoingRes.error;
    if (incomingRes.error) throw incomingRes.error;

    return NextResponse.json({
      ok: true,
      outgoing: outgoingRes.data ?? [],
      incoming: incomingRes.data ?? [],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

// -----------------------------------------------------------------------------
// POST /api/shared-bookmarks  — create an invite
//
// Body: { recipient_email: string }
// The recipient may not have signed up yet; we store the email, leave
// recipient_user_id null, and resolve on their first GET above. The
// unique constraint (owner_workspace_id, recipient_email, status)
// prevents duplicate pending invites; revoked ones can be re-invited.
// -----------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateBody;
    const rawEmail = (body.recipient_email ?? "").trim().toLowerCase();
    // Lightweight email shape check — we're not validating deliverability.
    if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return NextResponse.json(
        { ok: false, error: "Provide a valid email address." },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();

    // Idempotent: re-inviting the same email returns the existing
    // pending/accepted row rather than 409-ing.
    const { data: existing } = await sb.raw
      .from("shared_bookmarks")
      .select("id, status, created_at, recipient_email")
      .eq("owner_workspace_id", sb.workspaceId)
      .eq("recipient_email", rawEmail)
      .in("status", ["pending", "accepted"])
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ ok: true, share: existing, alreadyInvited: true });
    }

    const { data: inserted, error } = await sb.raw
      .from("shared_bookmarks")
      .insert({
        owner_workspace_id: sb.workspaceId,
        recipient_email: rawEmail,
        status: "pending",
      })
      .select("id, recipient_email, status, created_at")
      .single();
    if (error || !inserted) throw error || new Error("insert failed");
    return NextResponse.json({ ok: true, share: inserted, alreadyInvited: false });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
