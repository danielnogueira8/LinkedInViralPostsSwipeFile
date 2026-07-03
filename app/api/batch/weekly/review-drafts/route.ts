import { NextResponse } from "next/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { scopedSupabase } from "@/lib/supabase-scoped";
import {
  REVIEW_DRAFT_COLS,
  toReviewDraft,
  type ReviewDraftRow,
} from "@/lib/batch/review-draft";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/batch/weekly/review-drafts — the workspace's pending_review drafts.
//
// The batch review panel polls this while a batch is running so freshly-filed
// drafts appear in "Review this week's batch" in REAL TIME, per draft, without a
// full-page router.refresh() re-rendering the whole /posts tree on every tick.
// Returns the SAME ReviewDraft shape page.tsx builds for its first paint (shared
// mapper), so the panel's add-only reseed dedups cleanly by id. Workspace-scoped
// via scopedSupabase (RLS + app-layer .eq), newest first.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const workspaceId = await requireWorkspaceId();
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .select(REVIEW_DRAFT_COLS)
      .eq("workspace_id", workspaceId)
      .eq("status", "pending_review")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    const drafts = ((data ?? []) as ReviewDraftRow[]).map(toReviewDraft);
    return NextResponse.json({ ok: true, drafts });
  } catch (e) {
    return errorResponse(e);
  }
}
