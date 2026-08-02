import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { postCronAlert } from "@/lib/cron-alert";
import { scanAgentOpportunities } from "@/lib/agent-loop/scan";
import { scanTrendOpportunities } from "@/lib/agent-loop/trend-radar";
import { recoverStaleAgentOpportunityDrafts } from "@/lib/agent-loop/opportunity-claim";
import { latestRelevantScrape } from "@/lib/supabase-scoped";
import {
  scanFreshness,
  freshnessMessage,
} from "@/lib/agent-loop/scan-freshness";
import {
  MAX_WORKSPACES_PER_TICK,
  rotateForFairness,
} from "@/lib/agent-inbox/schedule";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Web-grounded discovery is materially slower than the local creator scan.
// Keep the existing all-workspace creator coverage, but rotate a small trend
// batch so one large fleet cannot make this cron exceed its 300s budget.
const TREND_RADAR_BATCH_SIZE = 6;
// The agent loop now runs once per day. Advance the fair trend batch once per
// day too, otherwise an hourly rotation sampled at a fixed daily time can
// revisit the same batch forever when the bucket count divides 24.
const TREND_RADAR_ROTATION_MS = 24 * 60 * 60 * 1000;

export function trendRadarWorkspaceIds(
  workspaceIds: readonly string[],
  now = new Date(),
): Set<string> {
  if (workspaceIds.length <= TREND_RADAR_BATCH_SIZE) return new Set(workspaceIds);
  const bucketCount = Math.ceil(workspaceIds.length / TREND_RADAR_BATCH_SIZE);
  const bucket =
    Math.floor(now.getTime() / TREND_RADAR_ROTATION_MS) % bucketCount;
  const start = bucket * TREND_RADAR_BATCH_SIZE;
  return new Set(workspaceIds.slice(start, start + TREND_RADAR_BATCH_SIZE));
}

async function discoverWorkspaceIds(
  sb: ReturnType<typeof supabaseAdmin>,
): Promise<string[]> {
  const discovered = new Set<string>();
  const PAGE = 1000;
  // A workspace can be useful before it has selected any Creator. Include the
  // durable app records that establish a personal workspace, while keeping
  // the old workspace_accounts pagination that protects creator coverage.
  const tables = ["workspace_accounts", "voice_profiles", "chats"] as const;
  for (const table of tables) {
    for (let from = 0; ; from += PAGE) {
      const query =
        table === "chats"
          ? sb
              .from("chats")
              .select("workspace_id")
              .is("archived_at", null)
              .order("workspace_id", { ascending: true })
              .range(from, from + PAGE - 1)
          : sb
              .from(table)
              .select("workspace_id")
              .order("workspace_id", { ascending: true })
              .range(from, from + PAGE - 1);
      const { data, error } = await query;
      if (error) throw error;
      for (const row of data ?? []) {
        if (typeof row.workspace_id === "string" && row.workspace_id) {
          discovered.add(row.workspace_id);
        }
      }
      if ((data ?? []).length < PAGE) break;
    }
  }
  return [...discovered].sort();
}

// Agent discovery loop (PLAN-agent-loop Phase D3). For every workspace, scan
// both tracked-creator outliers and creator-independent trend signals, leaving
// both proposed for the user to review. Drafting is deliberately user-triggered
// via the Agent feed or weekly cadence; a scheduled job must never create
// content the user did not request.
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
      // Workspaces are capped per run so a large fleet can't blow the cron
      // budget. Rotate the sorted list so the cap is fair across the fleet.
      workspaceIds = rotateForFairness(
        await discoverWorkspaceIds(sb),
        new Date(),
        MAX_WORKSPACES_PER_TICK,
      );
    }

    // Reclaim before scanning. Recovery is a prerequisite for truthful agent
    // state, so any schema/provider failure escapes to the outer handler and
    // triggers the standard cron alert instead of returning partial success.
    await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        try {
          const recovered = await recoverStaleAgentOpportunityDrafts(
            sb,
            workspaceId,
          );
          if (recovered > 0) {
            console.info("agent_opportunity_stale_claims_recovered", {
              workspace_id: workspaceId,
              count: recovered,
            });
          }
        } catch (error) {
          throw new Error(
            `Draft lease recovery failed for ${workspaceId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );

    const results: Array<{
      workspaceId: string;
      scanned?: number;
      inserted?: number;
      expired?: number;
      skipped?: string;
      trend?: Awaited<ReturnType<typeof scanTrendOpportunities>>;
      trend_skipped?: string;
      error?: string;
    }> = [];

    const trendTargets = trendRadarWorkspaceIds(workspaceIds);
    const trendScans = new Map<
      string,
      Awaited<ReturnType<typeof scanTrendOpportunities>>
    >();
    const trendErrors = new Map<string, string>();
    // Keep the batch concurrent: each search has a bounded provider timeout,
    // while the batch itself remains capped at six workspaces.
    await Promise.all(
      [...trendTargets].map(async (workspaceId) => {
        try {
          trendScans.set(
            workspaceId,
            await scanTrendOpportunities(sb, workspaceId),
          );
        } catch (error) {
          trendErrors.set(
            workspaceId,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    );

    for (const workspaceId of workspaceIds) {
      try {
        let creatorScan: Awaited<ReturnType<typeof scanAgentOpportunities>> = {
          scanned: 0,
          inserted: 0,
          expired: 0,
        };
        let skipped: string | undefined;
        let creatorError: string | undefined;

        // Only scan once today's scrape has actually COMPLETED. The scan used
        // to run purely on the 06:00 timer, six hours after /api/cron/daily
        // merely ENQUEUED the scrape — so a slow, retried or failed fetch left
        // it rebuilding "Model recently viral posts" from yesterday's pool with
        // no error anywhere. Skipping is the safe direction for that lane:
        // existing opportunities stay visible, and the next run picks them up
        // once the posts land. A forced manual trigger (?workspace=) bypasses
        // the gate. Trend Radar is independent of scrape freshness, so it
        // still runs when this creator lane is skipped.
        try {
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
              skipped = freshness.reason;
            }
          }
          if (!skipped) {
            creatorScan = await scanAgentOpportunities(sb, workspaceId);
          }
        } catch (error) {
          creatorError = error instanceof Error ? error.message : String(error);
        }

        // This lane deliberately does not depend on tracked creators or their
        // scrape freshness: it searches for timely developments in the wider
        // web and proposes them as Trend Radar candidates. A user can turn one
        // into a newsjacking post later from Cowork. Its rotating batch is
        // prepared above so the cron remains bounded.
        const trendScan = trendScans.get(workspaceId);
        const trendError = trendErrors.get(workspaceId);

        results.push({
          workspaceId,
          scanned: creatorScan.scanned,
          inserted: creatorScan.inserted,
          expired: creatorScan.expired,
          ...(skipped ? { skipped } : {}),
          ...(trendScan ? { trend: trendScan } : {}),
          ...(!trendScan && !trendError
            ? { trend_skipped: "rotating_batch" }
            : {}),
          ...(creatorError || trendError
            ? {
                error: [
                  creatorError ? `creator scan: ${creatorError}` : null,
                  trendError ? `trend scan: ${trendError}` : null,
                ]
                  .filter(Boolean)
                  .join("; "),
              }
            : {}),
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
