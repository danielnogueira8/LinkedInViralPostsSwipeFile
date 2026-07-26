import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { postCronAlert } from "@/lib/cron-alert";
import { distillEditDeltaRules } from "@/lib/voice-edit-distiller";
import { errorResponse } from "@/lib/workspace";
import { listWorkspacesWithPendingRevisionEvents } from "@/lib/content-learning/revision-events";

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
    const workspaceIds = await listWorkspacesWithPendingRevisionEvents(sb, 20);

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
    return errorResponse(error);
  }
}
