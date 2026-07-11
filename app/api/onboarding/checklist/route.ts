import { NextResponse } from "next/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { supabaseAdmin } from "@/lib/supabase";
import { canPublish, getConnection } from "@/lib/publishing";

export const runtime = "nodejs";

// The setting key that hides the first-run checklist for good once the user
// dismisses it (workspace-scoped, survives across devices/sessions).
const DISMISSED_KEY = "checklist_dismissed";

// POST /api/onboarding/checklist — dismiss the first-run checklist permanently
// for this workspace. Idempotent.
export async function POST() {
  try {
    const workspaceId = await requireWorkspaceId();
    const sb = supabaseAdmin();
    const { error } = await sb.from("settings").upsert(
      {
        workspace_id: workspaceId,
        key: DISMISSED_KEY,
        value: { at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,key" },
    );
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET() {
  try {
    const workspaceId = await requireWorkspaceId();
    const sb = supabaseAdmin();

    const [
      voiceRes,
      trackedRes,
      batchRes,
      scheduledRes,
      connection,
      dismissedRes,
    ] = await Promise.all([
      sb
        .from("voice_profiles")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("status", "ready"),
      sb
        .from("workspace_accounts")
        .select("account_id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId),
      sb
        .from("batch_runs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId),
      sb
        .from("chat_artifacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .or("schedule_status.in.(scheduled,publishing,published),status.eq.posted"),
      getConnection(workspaceId),
      sb
        .from("settings")
        .select("key", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("key", DISMISSED_KEY),
    ]);

    const trackedCount = trackedRes.count ?? 0;
    const trackedIds =
      trackedCount > 0
        ? await sb
            .from("workspace_accounts")
            .select("account_id")
            .eq("workspace_id", workspaceId)
        : { data: [] as Array<{ account_id: string }> };
    const accountIds = (trackedIds.data ?? []).map((row) => row.account_id);
    const inspirationRes =
      accountIds.length > 0
        ? await sb
            .from("posts")
            .select("id", { count: "exact", head: true })
            .in("account_id", accountIds)
        : { count: 0 };

    return NextResponse.json({
      ok: true,
      dismissed: (dismissedRes.count ?? 0) > 0,
      items: {
        voice: (voiceRes.count ?? 0) > 0,
        linkedin: canPublish(connection),
        creators: trackedCount > 0,
        inspiration: (inspirationRes.count ?? 0) > 0,
        batch: (batchRes.count ?? 0) > 0,
        scheduled: (scheduledRes.count ?? 0) > 0,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
