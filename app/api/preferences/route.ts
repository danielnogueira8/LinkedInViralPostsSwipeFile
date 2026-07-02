import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  preferenceInputSchema,
  isDuplicatePreference,
  PREFS_PER_WORKSPACE_MAX,
  type ContentPreference,
} from "@/lib/preferences";

export const runtime = "nodejs";

const PREF_COLS = "id, workspace_id, rule, source, created_at, updated_at";

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

    // Read the existing rules once — needed for BOTH the count cap and the
    // dedup check (so restating a rule the user already has is a friendly no-op,
    // not a twin row).
    const { data: existing, error: readErr } = await sb.raw
      .from("content_preferences")
      .select(PREF_COLS)
      .eq("workspace_id", sb.workspaceId);
    if (readErr) throw readErr;
    const rows = (existing ?? []) as ContentPreference[];

    if (rows.length >= PREFS_PER_WORKSPACE_MAX) {
      return NextResponse.json(
        {
          ok: false,
          error: `You've reached the limit of ${PREFS_PER_WORKSPACE_MAX} preferences. Delete one to add another.`,
        },
        { status: 409 },
      );
    }
    if (isDuplicatePreference(parsed.data.rule, rows)) {
      return NextResponse.json(
        { ok: false, error: "You already have that preference." },
        { status: 409 },
      );
    }

    const { data, error } = await sb.raw
      .from("content_preferences")
      .insert({
        rule: parsed.data.rule,
        source: "user",
        workspace_id: sb.workspaceId,
      })
      .select(PREF_COLS)
      .single();
    if (error) throw error;
    return NextResponse.json({
      ok: true,
      preference: data as ContentPreference,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
