import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { postCronAlert } from "@/lib/cron-alert";
import { scanAgentOpportunities } from "@/lib/agent-loop/scan";
import { latestRelevantScrape } from "@/lib/supabase-scoped";
import {
  scanFreshness,
  freshnessMessage,
} from "@/lib/agent-loop/scan-freshness";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Agent discovery loop (PLAN-agent-loop Phase D3). For every workspace that
// tracks at least one creator, scan for fresh opportunities and leave them
// proposed for the user to review. Drafting is deliberately user-triggered via
// the Agent feed or weekly cadence; a scheduled job must never create content
// the user did not request.
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

    let workspaceIds: string[];
    if (workspaceParam) {
      // Manual single-workspace trigger (scripts/trigger-agent-loop.ts).
      workspaceIds = [workspaceParam];
    } else {
      // Always-on: the loop runs for every workspace that tracks at least one
      // creator (the scanner no-ops cleanly when a workspace has none).
      // Paginate the full join table: a flat LIMIT here truncates on row order
      // (insertion order), which silently skipped live workspaces whose
      // workspace_accounts rows sort late (the org→user rekey ghost bug —
      // drafts landed in a workspace the user can't see). Deterministic order
      // + full pagination guarantees every workspace is discovered.
      const discovered = new Set<string>();
      const PAGE = 1000;
      for (let from = 0; from < 20 * PAGE; from += PAGE) {
        const { data: tracked, error: trackedError } = await sb
          .from("workspace_accounts")
          .select("workspace_id")
          .order("workspace_id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (trackedError) throw trackedError;
        for (const row of tracked ?? []) {
          discovered.add(row.workspace_id as string);
        }
        if ((tracked ?? []).length < PAGE) break;
      }
      // Workspaces are capped per run so a large fleet can't blow the cron
      // budget; deterministic order keeps coverage stable run-over-run.
      workspaceIds = [...discovered].sort().slice(0, 50);
    }

    const results: Array<{
      workspaceId: string;
      scanned?: number;
      inserted?: number;
      expired?: number;
      skipped?: string;
      error?: string;
    }> = [];

    for (const workspaceId of workspaceIds) {
      try {
        // Only scan once today's scrape has actually COMPLETED. The scan used
        // to run purely on the 06:00 timer, six hours after /api/cron/daily
        // merely ENQUEUED the scrape — so a slow, retried or failed fetch left
        // it rebuilding "Model recently viral posts" from yesterday's pool with
        // no error anywhere. Skipping is the safe direction: the existing
        // opportunities stay visible, and the next run picks them up once the
        // posts land. A forced manual trigger (?workspace=) bypasses the gate.
        if (!workspaceParam) {
          const run = await latestRelevantScrape(workspaceId).catch(() => null);
          const freshness = scanFreshness(run, new Date());
          if (!freshness.fresh) {
            console.warn(
              JSON.stringify({
                agent_loop_scan_skipped: {
                  workspace_id: workspaceId,
                  reason: freshness.reason,
                  message: freshnessMessage(freshness),
                },
              }),
            );
            results.push({ workspaceId, skipped: freshness.reason });
            continue;
          }
        }
        const scan = await scanAgentOpportunities(sb, workspaceId);

        results.push({
          workspaceId,
          scanned: scan.scanned,
          inserted: scan.inserted,
          expired: scan.expired,
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
    return errorResponse(error);
  }
}
