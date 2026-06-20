import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/model-source/[id] — fetch a stashed post to model after. The chat
// calls this when it sees ?model=<id>, to render the source-post chip and load
// the full text into the modeling prompt.
// -----------------------------------------------------------------------------
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chat_modeling_sources")
      .select("id, post_text, author_name, author_avatar, source, partial, created_at")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Source not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, source: data });
  } catch (e) {
    return errorResponse(e);
  }
}
