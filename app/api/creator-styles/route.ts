import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { creatorStyleCreateSchema, type CreatorStyleRow } from "@/lib/creator-styles";
import { recoverStaleGeneratingStyle } from "@/lib/creator-styles-cooldown";
import {
  CREATOR_STYLE_COLS,
  startCreatorStyleGeneration,
} from "@/lib/creator-style-operations";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("creator_style_profiles")
      .select(CREATOR_STYLE_COLS)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const styles = await Promise.all(
      ((data ?? []) as CreatorStyleRow[]).map((row) =>
        recoverStaleGeneratingStyle(sb, row),
      ),
    );
    return NextResponse.json({ ok: true, styles });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = creatorStyleCreateSchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const result = await startCreatorStyleGeneration({
      workspaceId: sb.workspaceId,
      data: parsed.data,
      db: sb.raw,
    });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json(
      { ok: true, style: result.style },
      { status: result.status },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
