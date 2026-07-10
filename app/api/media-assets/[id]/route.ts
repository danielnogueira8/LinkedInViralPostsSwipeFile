import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// SOFT-DELETE ONLY. Storage is hard-deleted later by the reference-aware sweep
// (scripts/sweep-deleted-media.ts), not synchronously here.
//
// Why: attachments on a draft/scheduled post are a SNAPSHOT — the asset id is
// copied into chat_artifacts.media_attachments at attach time, not a live
// reference. Nothing here ever checked whether a draft/scheduled post still
// referenced this asset before nuking its storage object, so deleting a
// library asset could silently break a draft's preview or a scheduled post's
// media. Marking deleted_at and returning immediately (same latency/UX as
// before) gives the sweep a grace window to find real references before the
// bytes are actually gone; reads already filter deleted_at is null
// (lib/media-library.ts) so this asset stops appearing in the library the
// same instant it does today — only the storage removal timing changes.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data: asset, error } = await sb.raw
      .from("media_assets")
      .select("id")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!asset) {
      return NextResponse.json({ ok: false, error: "Media not found." }, { status: 404 });
    }

    const { error: updateError } = await sb.raw
      .from("media_assets")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId);
    if (updateError) throw updateError;

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
