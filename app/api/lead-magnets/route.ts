import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  LEAD_MAGNET_AI_MONTHLY_LIMIT,
  LEAD_MAGNET_COLS,
  coerceLeadMagnet,
  leadMagnetInputSchema,
  monthStartIso,
  type LeadMagnet,
} from "@/lib/lead-magnets";
import { createLeadMagnetResource } from "@/lib/content-resource-operations";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { userId } = await auth();
    const sb = await scopedSupabase();
    const [listRes, usageRes] = await Promise.all([
      sb.raw
        .from("lead_magnets")
        .select(LEAD_MAGNET_COLS)
        .eq("workspace_id", sb.workspaceId)
        .order("updated_at", { ascending: false }),
      userId
        ? sb.raw
            .from("lead_magnets")
            .select("id", { count: "exact", head: true })
            .eq("user_id", userId)
            .eq("source_type", "ai")
            .gte("created_at", monthStartIso())
        : Promise.resolve({ count: 0, error: null }),
    ]);
    const { data, error } = listRes;
    if (error) throw error;
    if (usageRes.error) throw usageRes.error;
    return NextResponse.json({
      ok: true,
      leadMagnets: ((data ?? []) as LeadMagnet[]).map(coerceLeadMagnet),
      aiUsage: {
        used: usageRes.count ?? 0,
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
    const result = await createLeadMagnetResource({
      db: sb.raw,
      workspaceId: sb.workspaceId,
      userId,
      data: parsed.data,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, leadMagnet: result.value });
  } catch (e) {
    return errorResponse(e);
  }
}
