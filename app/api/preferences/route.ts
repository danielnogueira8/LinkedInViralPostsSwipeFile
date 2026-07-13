import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  preferenceInputSchema,
  type ContentPreference,
} from "@/lib/preferences";
import {
  createPreferenceResource,
  PREF_COLS,
} from "@/lib/content-resource-operations";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/preferences — list + create the workspace's standing writing rules.
// Workspace-scoped via scopedSupabase (RLS also enforces it). The count cap +
// rule validation are shared with the agent injection (lib/preferences), so the
// injected block can't balloon and the rule count can't grow without limit.
// -----------------------------------------------------------------------------

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("content_preferences")
      .select(PREF_COLS)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({
      ok: true,
      preferences: (data ?? []) as ContentPreference[],
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = preferenceInputSchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();

    const result = await createPreferenceResource({
      db: sb.raw,
      workspaceId: sb.workspaceId,
      data: parsed.data,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, preference: result.value });
  } catch (e) {
    return errorResponse(e);
  }
}
