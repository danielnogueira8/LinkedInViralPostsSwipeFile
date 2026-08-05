import { NextResponse } from "next/server";
import { createProductionAgentInbox } from "@/lib/agent-inbox/service";
import {
  MAX_WORKSPACES_PER_TICK,
  isDueNow,
  rotateForFairness,
} from "@/lib/agent-inbox/schedule";
import { listAgentInboxWorkspaces } from "@/lib/agent-inbox/supabase";
import { supabaseAdmin } from "@/lib/supabase";
import { cronRunStatus, recordCronRun } from "@/lib/cron-run-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const cronStartedAt = new Date();
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
  // Same partial-failure shape as agent-loop: the per-workspace catch keeps a
  // single bad workspace from sinking the tick, so a run with failures is
  // indistinguishable from a clean one without this.
  const failed = results.filter((entry) => "error" in entry).length;
  await recordCronRun({
    job: "agent-inbox",
    status: cronRunStatus({ total: results.length, failed }),
    startedAt: cronStartedAt,
    counts: {
      workspaces: results.length,
      failed,
      created: results.reduce(
        (total, entry) =>
          total + (typeof entry.created === "number" ? entry.created : 0),
        0,
      ),
    },
  });
  return NextResponse.json({ ok: true, results });
}
