/**
 * Manual agent-loop runner (PLAN-agent-loop Phase D).
 *
 * Scans for fresh opportunities and optionally drafts the top ones, without
 * waiting for the daily cron. Defaults to a dry scan so you can inspect what
 * would be proposed before spending any LLM calls.
 *
 * NOTE: `--execute` runs the chat pipeline in this standalone tsx process. That
 * path imports Next.js server modules and can fail outside the Next runtime.
 * For a real production execution, use scripts/trigger-agent-loop.ts against
 * the deployed cron route instead.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/run-agent-loop.ts \
 *     --workspace <workspace_id> [--execute] [--cap 2]
 *
 * Omit --workspace to run for every workspace that tracks at least one creator
 * (same scope as the cron, capped at 20 workspaces per run).
 */

import { supabaseAdmin } from "@/lib/supabase";
import { scanAgentOpportunities } from "@/lib/agent-loop/scan";
import {
  actOnOpportunity,
  type AgentOpportunityRow,
} from "@/lib/agent-loop/act";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const workspaceArg = arg("workspace");
const execute = process.argv.includes("--execute");
const cap = Math.max(1, Number(arg("cap") ?? 2) || 2);

async function workspacesToRun(sb: ReturnType<typeof supabaseAdmin>) {
  if (workspaceArg) return [workspaceArg];
  const { data, error } = await sb
    .from("workspace_accounts")
    .select("workspace_id")
    .limit(500);
  if (error) throw error;
  return [...new Set((data ?? []).map((row) => row.workspace_id as string))].slice(
    0,
    20,
  );
}

async function main() {
  const sb = supabaseAdmin();
  const workspaceIds = await workspacesToRun(sb);
  if (workspaceIds.length === 0) {
    console.log("No workspaces with tracked creators found.");
    return;
  }

  console.log(
    `Running agent loop for ${workspaceIds.length} workspace(s). Mode: ${
      execute ? "EXECUTE" : "DRY SCAN"
    }, cap ${cap} drafts/workspace.`,
  );

  for (const workspaceId of workspaceIds) {
    console.log(`\n=== workspace ${workspaceId} ===`);
    const scan = await scanAgentOpportunities(sb, workspaceId);
    console.log(
      `scan: ${scan.scanned} fresh posts, ${scan.inserted} inserted, ${scan.expired} expired`,
    );

    const { data: opportunities, error } = await sb
      .from("agent_opportunities")
      .select("id, source_post_id, payload, score")
      .eq("workspace_id", workspaceId)
      .eq("status", "proposed")
      .order("score", { ascending: false })
      .limit(cap);
    if (error) throw error;

    if ((opportunities ?? []).length === 0) {
      console.log("no proposed opportunities");
      continue;
    }

    for (const opportunity of (opportunities ?? []) as Array<
      AgentOpportunityRow & { score?: number }
    >) {
      const headline =
        typeof opportunity.payload?.headline === "string"
          ? opportunity.payload.headline
          : "(no headline)";
      console.log(
        `  [${opportunity.id}] score=${opportunity.score ?? "?"} — ${headline}`,
      );
      if (execute) {
        const result = await actOnOpportunity(sb, workspaceId, opportunity);
        if (result.ok) {
          console.log(`    → drafted: ${result.draftIds.join(", ")}`);
        } else {
          console.log(`    → failed: ${result.reason}`);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
