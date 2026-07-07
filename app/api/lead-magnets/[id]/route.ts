import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { normalizeCollapsedMarkdownTables } from "@/lib/markdown-tables";
import {
  LEAD_MAGNET_COLS,
  coerceLeadMagnet,
  leadMagnetInputSchema,
  normalizeLeadMagnetMetadata,
  type LeadMagnet,
} from "@/lib/lead-magnets";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = leadMagnetInputSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const markdownBody = normalizeCollapsedMarkdownTables(parsed.data.markdown_body).trim();
    const metadata = normalizeLeadMagnetMetadata(parsed.data.metadata, markdownBody);
    const { data, error } = await sb.raw
      .from("lead_magnets")
      .update({
        title: parsed.data.title,
        markdown_body: markdownBody,
        source_url: parsed.data.source_url ?? null,
        is_public: parsed.data.is_public,
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select(LEAD_MAGNET_COLS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Lead magnet not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, leadMagnet: coerceLeadMagnet(data as LeadMagnet) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("lead_magnets")
      .delete()
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json({ ok: false, error: "Lead magnet not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
