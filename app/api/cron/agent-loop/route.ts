import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { postCronAlert } from "@/lib/cron-alert";
import { scanAgentOpportunities } from "@/lib/agent-loop/scan";
import { actOnOpportunity, type AgentOpportunityRow } from "@/lib/agent-loop/act";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_DAILY_DRAFT_CAP = 3;

// Daily agent loop (PLAN-agent-loop Phase D3). For every workspace that tracks
// at least one creator, scan for fresh opportunities and draft the top 1–2 into
// the system chat ("Your agent"). Hard-capped per run; a failed opportunity
// stays proposed for a retry on the next run.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const sb = supabaseAdmin();
    const url = new URL(req.url);
    const workspaceParam = url.searchParams.get("workspace");
    const capParam = Number(url.searchParams.get("cap"));
    const draftCap = Math.max(
      1,
      (Number.isFinite(capParam) && capParam > 0 ? capParam : undefined) ??
        Number(process.env.AGENT_DAILY_DRAFT_CAP ?? DEFAULT_DAILY_DRAFT_CAP) ??
        DEFAULT_DAILY_DRAFT_CAP,
    );

    let workspaceIds: string[];
    if (workspaceParam) {
      // Manual single-workspace trigger (scripts/trigger-agent-loop.ts).
      workspaceIds = [workspaceParam];
    } else {
      // Always-on: the loop runs for every workspace that tracks at least one
      // creator (the scanner no-ops cleanly when a workspace has none). Workspaces
      // are capped per run so a large fleet can't blow the cron budget.
      const { data: tracked, error: trackedError } = await sb
        .from("workspace_accounts")
        .select("workspace_id")
        .limit(500);
      if (trackedError) throw trackedError;
      workspaceIds = [
        ...new Set((tracked ?? []).map((row) => row.workspace_id as string)),
      ].slice(0, 20);
    }

    const results: Array<{
      workspaceId: string;
      scanned?: number;
      inserted?: number;
      expired?: number;
      draftedToday?: number;
      acted?: Array<{ id: string; ok: boolean; reason?: string }>;
      error?: string;
    }> = [];

    for (const workspaceId of workspaceIds) {
      try {
        const scan = await scanAgentOpportunities(sb, workspaceId);

        // Hard daily cap: count drafts already completed today (UTC) so manual
        // triggers can't push a workspace past the limit.
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        const { count: draftedToday, error: countError } = await sb
          .from("agent_opportunities")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .eq("status", "drafted")
          .gte("acted_at", startOfDay.toISOString());
        if (countError) throw countError;
        const remaining = Math.max(0, draftCap - (draftedToday ?? 0));

        const acted: Array<{ id: string; ok: boolean; reason?: string }> = [];
        if (remaining > 0) {
          const { data: opportunities, error: oppError } = await sb
            .from("agent_opportunities")
            .select("id, source_post_id, payload")
            .eq("workspace_id", workspaceId)
            .eq("status", "proposed")
            .order("score", { ascending: false })
            .limit(remaining);
          if (oppError) throw oppError;

          for (const opportunity of (opportunities ?? []) as AgentOpportunityRow[]) {
            const result = await actOnOpportunity(sb, workspaceId, opportunity);
            acted.push(
              result.ok
                ? { id: opportunity.id, ok: true }
                : { id: opportunity.id, ok: false, reason: result.reason },
            );
          }
        }

        results.push({
          workspaceId,
          scanned: scan.scanned,
          inserted: scan.inserted,
          expired: scan.expired,
          draftedToday: draftedToday ?? 0,
          acted,
        });
      } catch (error) {
        results.push({
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return NextResponse.json({ ok: true, workspaces: results });
  } catch (error) {
    console.error("agent-loop cron failed", (error as Error)?.message);
    await postCronAlert({ cron: "agent-loop" }, error);
    return NextResponse.json(
      { ok: false, error: (error as Error)?.message ?? "Unexpected error" },
      { status: 500 },
    );
  }
}
