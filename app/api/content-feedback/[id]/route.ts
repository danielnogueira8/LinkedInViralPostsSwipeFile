import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data: deleted, error } = await sb.raw
      .from("content_feedback")
      .delete()
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id");
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Feedback not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
