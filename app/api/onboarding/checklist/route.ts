import { NextResponse } from "next/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { supabaseAdmin } from "@/lib/supabase";
import { canPublish, getConnection } from "@/lib/publishing";

export const runtime = "nodejs";

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
