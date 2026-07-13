import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { resolveWorkspaceDisplays } from "@/lib/workspace-display";

export const runtime = "nodejs";

// Validate + normalize the invite body up front, so a non-string / missing /
// malformed field is rejected with a clean 400 instead of being coerced. Caps
// the length so a giant paste can't reach the DB. Deliverability isn't checked —
// this is a shape gate, matching the prior lightweight regex.
const createSchema = z.object({
  recipient_email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Provide a valid email address."),
});

// -----------------------------------------------------------------------------
// GET /api/shared-bookmarks
//
// Returns:
//   outgoing  — shares this workspace has issued (any status)
//   incoming  — shares addressed to the calling user (pending or accepted)
//
// Pending invites are resolved by the explicit POST to /pending-count before
// this read. Keeping GET read-only prevents link prefetching or forged GETs
// from mutating invite ownership.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { userId } = await auth();

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

    const incoming = (incomingRes.data ?? []) as Array<{
      id: string;
      owner_workspace_id: string;
      status: string;
      created_at: string;
      accepted_at: string | null;
    }>;
    const displays = await resolveWorkspaceDisplays(
      Array.from(new Set(incoming.map((share) => share.owner_workspace_id))),
    );

    return NextResponse.json({
      ok: true,
      outgoing: outgoingRes.data ?? [],
      incoming: incoming.map((share) => {
        const display = displays.get(share.owner_workspace_id);
        return {
          ...share,
          owner_name: display?.name ?? "Someone",
          owner_email: display?.email ?? null,
        };
      }),
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
    const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Provide a valid email address." },
        { status: 400 },
      );
    }
    const rawEmail = parsed.data.recipient_email;
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
    if (error || !inserted) {
      // The "already invited?" SELECT above and this INSERT aren't atomic, so
      // two concurrent submits of the same email both pass the check and race
      // to insert. The loser trips the unique constraint
      // (owner_workspace_id, recipient_email, status) → Postgres 23505. Treat
      // it as "already invited" by returning the row the winner created,
      // rather than surfacing a raw 500. Mirrors the saved-posts POST.
      if (error?.code === "23505") {
        const { data: row } = await sb.raw
          .from("shared_bookmarks")
          .select("id, status, created_at, recipient_email")
          .eq("owner_workspace_id", sb.workspaceId)
          .eq("recipient_email", rawEmail)
          .in("status", ["pending", "accepted"])
          .maybeSingle();
        if (row) return NextResponse.json({ ok: true, share: row, alreadyInvited: true });
      }
      throw error || new Error("insert failed");
    }
    return NextResponse.json({ ok: true, share: inserted, alreadyInvited: false });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
