import { NextResponse } from "next/server";
import { createProductionAgentInbox } from "@/lib/agent-inbox/service";
import { listAgentInboxWorkspaces } from "@/lib/agent-inbox/supabase";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  const db = supabaseAdmin();
  const service = createProductionAgentInbox(db);
  const now = new Date();
  const requested = new URL(request.url).searchParams.get("workspace");
  const workspaces = requested
    ? [{ workspaceId: requested, timezone: "UTC", deliveryLocalTime: "00:00" }]
    : await listAgentInboxWorkspaces(db);
  const results = [];
  for (const workspace of workspaces.slice(0, 50)) {
    try {
      const localTime = new Intl.DateTimeFormat("en-GB", {
        timeZone: workspace.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(now);
      if (!requested && localTime < workspace.deliveryLocalTime) continue;
      const result = await service.replenish({
        workspaceId: workspace.workspaceId,
        timezone: workspace.timezone,
        now,
      });
      results.push({
        workspaceId: workspace.workspaceId,
        created: result.created.length,
        skipped: result.skipped,
      });
    } catch (error) {
      console.error("[agent-inbox:workspace]", workspace.workspaceId, error);
      results.push({ workspaceId: workspace.workspaceId, error: "failed" });
    }
  }
  return NextResponse.json({ ok: true, results });
}
