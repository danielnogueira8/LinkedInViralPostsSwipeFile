import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  LEAD_MAGNET_AI_MONTHLY_LIMIT,
  LEAD_MAGNET_COLS,
  coerceLeadMagnet,
  leadMagnetInputSchema,
  makePublicSlug,
  monthStartIso,
  normalizeLeadMagnetMetadata,
  type LeadMagnet,
} from "@/lib/lead-magnets";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { userId } = await auth();
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("lead_magnets")
      .select(LEAD_MAGNET_COLS)
      .eq("workspace_id", sb.workspaceId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    let aiUsed = 0;
    if (userId) {
      const { count, error: countError } = await sb.raw
        .from("lead_magnets")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("source_type", "ai")
        .gte("created_at", monthStartIso());
      if (countError) throw countError;
      aiUsed = count ?? 0;
    }
    return NextResponse.json({
      ok: true,
      leadMagnets: ((data ?? []) as LeadMagnet[]).map(coerceLeadMagnet),
      aiGeneration: {
        used: aiUsed,
        limit: LEAD_MAGNET_AI_MONTHLY_LIMIT,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = leadMagnetInputSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
    const sb = await scopedSupabase();
    const metadata = normalizeLeadMagnetMetadata(parsed.data.metadata, parsed.data.markdown_body);
    const { data, error } = await sb.raw
      .from("lead_magnets")
      .insert({
        workspace_id: sb.workspaceId,
        user_id: userId,
        title: parsed.data.title,
        markdown_body: parsed.data.markdown_body,
        source_url: parsed.data.source_url ?? null,
        source_type: "manual",
        public_slug: makePublicSlug(parsed.data.title),
        is_public: parsed.data.is_public,
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
