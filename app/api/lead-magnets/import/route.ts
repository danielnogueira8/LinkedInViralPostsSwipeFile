import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { importLeadMagnetFromUrl } from "@/lib/lead-magnet-import";
import { normalizeCollapsedMarkdownTables } from "@/lib/markdown-tables";
import {
  LEAD_MAGNET_COLS,
  coerceLeadMagnet,
  leadMagnetImportSchema,
  makePublicSlug,
  normalizeLeadMagnetMetadata,
  type LeadMagnet,
} from "@/lib/lead-magnets";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const parsed = leadMagnetImportSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
    const sb = await scopedSupabase();
    const imported = await importLeadMagnetFromUrl(parsed.data.url);
    const markdownBody = normalizeCollapsedMarkdownTables(imported.markdown).trim();
    const metadata = normalizeLeadMagnetMetadata(null, markdownBody);
    const { data, error } = await sb.raw
      .from("lead_magnets")
      .insert({
        workspace_id: sb.workspaceId,
        user_id: userId,
        title: imported.title,
        markdown_body: markdownBody,
        source_url: parsed.data.url,
        source_type: "url",
        public_slug: makePublicSlug(imported.title),
        is_public: true,
        metadata,
      })
      .select(LEAD_MAGNET_COLS)
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, leadMagnet: coerceLeadMagnet(data as LeadMagnet) });
  } catch (e) {
    return errorResponse(e);
  }
}
