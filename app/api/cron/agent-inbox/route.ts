import { NextResponse } from "next/server";
import { createProductionAgentInbox } from "@/lib/agent-inbox/service";
import {
  MAX_WORKSPACES_PER_TICK,
  isDueNow,
  rotateForFairness,
} from "@/lib/agent-inbox/schedule";
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
  // Filter to the workspaces actually due before capping. Slicing first spent
  // slots on workspaces whose delivery time had not arrived, and the list is
  // sorted by workspace id — so the same alphabetical tail was starved every
  // tick rather than merely delayed.
  const due = requested
    ? workspaces
    : workspaces.filter((workspace) =>
        isDueNow(now, workspace.timezone, workspace.deliveryLocalTime),
      );
  const batch = requested
    ? due
    : rotateForFairness(due, now, MAX_WORKSPACES_PER_TICK);
  const results = [];
  for (const workspace of batch) {
    try {
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
