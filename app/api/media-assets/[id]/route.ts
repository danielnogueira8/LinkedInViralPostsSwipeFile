import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data: asset, error } = await sb.raw
      .from("media_assets")
      .select("id, storage_bucket, storage_path")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!asset) {
      return NextResponse.json({ ok: false, error: "Media not found." }, { status: 404 });
    }

    await sb.raw
      .from("media_assets")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId);

    await sb.raw.storage
      .from(String(asset.storage_bucket))
      .remove([String(asset.storage_path)]);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
