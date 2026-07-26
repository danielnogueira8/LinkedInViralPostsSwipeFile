import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  preferenceInputSchema,
  isDuplicatePreference,
  type ContentPreference,
} from "@/lib/preferences";

export const runtime = "nodejs";

const PREF_COLS = "id, workspace_id, rule, detail, source, created_at, updated_at";

// -----------------------------------------------------------------------------
// /api/preferences/[id] — edit or delete one preference. Workspace-scoped: the
// query filters on workspace_id (RLS also enforces it), and .select() detects
// whether anything in THIS workspace matched → 404 otherwise. Editing a rule
// (learned or user-authored) doesn't change its source — the user has vetted it
// either way; deleting is the one-click undo for a mis-learned rule.
// -----------------------------------------------------------------------------

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
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

    // Dedup against the OTHER rules (exclude this row) so an edit can't collide
    // with an existing preference.
    const { data: others, error: readErr } = await sb.raw
      .from("content_preferences")
      .select(PREF_COLS)
      .eq("workspace_id", sb.workspaceId)
      .neq("id", id);
    if (readErr) throw readErr;
    if (
      isDuplicatePreference(
        parsed.data.rule,
        (others ?? []) as ContentPreference[],
      )
    ) {
      return NextResponse.json(
        { ok: false, error: "You already have that preference." },
        { status: 409 },
      );
    }

    const { data, error } = await sb.raw
      .from("content_preferences")
      .update({
        rule: parsed.data.rule,
        detail: parsed.data.detail || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select(PREF_COLS)
      .maybeSingle();
    if (error?.code === "23505") {
      return NextResponse.json(
        { ok: false, error: "You already have that preference." },
        { status: 409 },
      );
    }
    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { ok: false, error: "Preference not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      preference: data as ContentPreference,
    });
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
    const { data: deleted, error } = await sb.raw
      .from("content_preferences")
      .delete()
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id");
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Preference not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
