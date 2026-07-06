import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data: asset, error } = await sb.raw
      .from("media_assets")
      .select("id, mime_type, media_type, storage_bucket, storage_path")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!asset) {
      return NextResponse.json({ ok: false, error: "Media not found." }, { status: 404 });
    }
    if (asset.media_type !== "image") {
      return NextResponse.json({ ok: false, error: "Preview is only available for images." }, { status: 400 });
    }

    const download = await sb.raw.storage
      .from(String(asset.storage_bucket))
      .download(String(asset.storage_path));
    if (download.error || !download.data) throw download.error ?? new Error("Could not load preview.");

    return new NextResponse(download.data, {
      headers: {
        "Content-Type": String(asset.mime_type),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
