import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { postCronAlert } from "@/lib/cron-alert";
import { distillEditDeltaRules } from "@/lib/voice-edit-distiller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Daily edit-delta distillation (PLAN-agent-loop Phase C2). Runs once per day
// and processes up to 20 workspaces that had draft edits in the last 24h. One
// BACKGROUND_MODEL call per workspace; the only state written is new
// content_preferences rows (source "edit_delta"). Best-effort per workspace.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const sb = supabaseAdmin();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: workspaces, error: wsError } = await sb
      .from("draft_edit_events")
      .select("workspace_id")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200);
    if (wsError) throw wsError;

    const workspaceIds = [
      ...new Set((workspaces ?? []).map((row) => row.workspace_id as string)),
    ].slice(0, 20);

    const results: Array<{
      workspaceId: string;
      inserted: number;
      skippedDuplicates: number;
      candidates: number;
      error?: string;
    }> = [];
    for (const workspaceId of workspaceIds) {
      try {
        const result = await distillEditDeltaRules(sb, workspaceId);
        results.push({ workspaceId, ...result });
      } catch (error) {
        results.push({
          workspaceId,
          inserted: 0,
          skippedDuplicates: 0,
          candidates: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return NextResponse.json({ ok: true, workspaces: results });
  } catch (error) {
    console.error("edit-delta-distill cron failed", (error as Error)?.message);
    await postCronAlert({ cron: "edit-delta-distill" }, error);
    return NextResponse.json(
      { ok: false, error: (error as Error)?.message ?? "Unexpected error" },
      { status: 500 },
    );
  }
}
