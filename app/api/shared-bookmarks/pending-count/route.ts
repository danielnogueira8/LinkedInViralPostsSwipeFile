import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { scopedSupabase } from "@/lib/supabase-scoped";
import { verifiedPrimaryEmail } from "@/lib/shared-bookmarks";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: true, count: 0 });
    }

    const user = await currentUser();
    const email = verifiedPrimaryEmail(user);

    if (email) {
      await sb.raw
        .from("shared_bookmarks")
        .update({ recipient_user_id: userId })
        .eq("recipient_email", email)
        .eq("status", "pending")
        .is("recipient_user_id", null);
    }

    const { count, error } = await sb.raw
      .from("shared_bookmarks")
      .select("id", { count: "exact", head: true })
      .eq("recipient_user_id", userId)
      .eq("status", "pending");
    if (error) throw error;

    return NextResponse.json({ ok: true, count: count ?? 0 });
  } catch (error) {
    return errorResponse(error);
  }
}
