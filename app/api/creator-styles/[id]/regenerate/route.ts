import { NextResponse, after } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { runCreatorStyleGeneration } from "@/lib/agent/creator-style-profile";

export const runtime = "nodejs";
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// POST /api/creator-styles/[id]/regenerate — re-distill an existing style from
// the same source (its stored source_account_id, or its saved-post references).
// Flips the row to 'generating' and re-runs in after(). Workspace-scoped: the
// row is fetched by (id, workspace_id) → 404 otherwise, so a client can't
// regenerate another workspace's style.
// -----------------------------------------------------------------------------
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();

    // Load the row (scoped) to recover its source. Prefer the stored account;
    // fall back to the saved-post references if it was built from a saved set.
    const { data: row } = await sb.raw
      .from("creator_style_profiles")
      .select("id, source_account_id")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ ok: false, error: "Style not found" }, { status: 404 });
    }
    const sourceAccountId = (row.source_account_id as string | null) ?? null;
    let savedPostIds: string[] | null = null;
    if (!sourceAccountId) {
      const { data: srcs } = await sb.raw
        .from("creator_style_profile_sources")
        .select("saved_post_id")
        .eq("profile_id", id)
        .eq("workspace_id", sb.workspaceId)
        .not("saved_post_id", "is", null);
      savedPostIds = ((srcs ?? []) as Array<{ saved_post_id: string | null }>)
        .map((s) => s.saved_post_id)
        .filter((x): x is string => !!x);
    }

    // Flip to generating (clears the prior error/timestamp).
    await sb.raw
      .from("creator_style_profiles")
      .update({ status: "generating", error: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId);

    after(() =>
      runCreatorStyleGeneration({
        workspaceId: sb.workspaceId,
        profileId: id,
        sourceAccountId,
        savedPostIds,
      }),
    );

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
