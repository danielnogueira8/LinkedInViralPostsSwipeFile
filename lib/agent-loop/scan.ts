import { selectAllRows, selectInChunks } from "@/lib/db-paginate";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  creatorBaselinesFromRows,
  outlierMetricLabel,
  type MetricBaseline,
} from "@/lib/outlier-metric";

// ---------------------------------------------------------------------------
// Agent loop scanner (PLAN-agent-loop Phase D2).
//
// Deterministic: reads fresh viral posts from the workspace's tracked creators,
// expires stale opportunities, and writes the top-ranked ones as `proposed`.
// No LLM is involved — proposals are templated from the post payload.
// ---------------------------------------------------------------------------

const FRESH_WINDOW_HOURS = 72;
const BASELINE_WINDOW_DAYS = 90;
const EXPIRE_AFTER_DAYS = 5;
const SOURCE_COOLDOWN_DAYS = 30;
const MAX_PROPOSED_PER_RUN = 3;

export type AgentOpportunityPostRow = {
  id: string;
  account_id?: string;
  text: string | null;
  post_url: string | null;
  viral_score: number | null;
  reactions: number | null;
  comments: number | null;
  posted_at: string | null;
  accounts: { name?: string | null } | Array<{ name?: string | null }> | null;
};

function accountName(row: AgentOpportunityPostRow): string {
  const acc = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
  return (acc?.name as string | null) ?? "A tracked creator";
}

function hoursAgo(iso: string | null): number {
  if (!iso) return FRESH_WINDOW_HOURS;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return FRESH_WINDOW_HOURS;
  return Math.max(0, (Date.now() - then) / (1000 * 60 * 60));
}

function freshnessMultiplier(postedAt: string | null): number {
  const age = hoursAgo(postedAt);
  return 0.5 + 0.5 * Math.exp(-age / 24);
}

export function scoreAgentOpportunityPost(row: AgentOpportunityPostRow): number {
  const viral = typeof row.viral_score === "number" ? row.viral_score : 0;
  return freshnessMultiplier(row.posted_at) * Math.log1p(Math.max(0, viral));
}

function snippet(text: string | null, max = 80): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function agentOpportunityHeadline(
  row: AgentOpportunityPostRow,
  baseline?: MetricBaseline | null,
): string {
  const author = accountName(row);
  const label = outlierMetricLabel(
    { reactions: row.reactions, comments: row.comments },
    baseline,
  );
  const excerpt = snippet(row.text);
  return `${author} — ${label} — "${excerpt}" — draft it?`;
}

export type ScanAgentOpportunitiesResult = {
  scanned: number;
  inserted: number;
  expired: number;
};

export async function scanAgentOpportunities(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<ScanAgentOpportunitiesResult> {
  // Expire stale proposals first so the pool never grows unbounded.
  const expireCutoff = new Date(
    Date.now() - EXPIRE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: expiredRows } = await sb
    .from("agent_opportunities")
    .update({ status: "expired", acted_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .in("status", ["proposed", "drafting"])
    .lt("created_at", expireCutoff)
    .select("id");
  const expired = (expiredRows ?? []).length;

  const { data: trackers, error: trackersError } = await sb
    .from("workspace_accounts")
    .select("account_id")
    .eq("workspace_id", workspaceId);
  if (trackersError) throw trackersError;
  const accountIds = (trackers ?? []).map((row) => row.account_id as string);
  if (accountIds.length === 0) {
    return { scanned: 0, inserted: 0, expired };
  }

  // Cooldown: any source already seen as an opportunity in the last 30 days is
  // skipped, so the loop doesn't re-pitch the same post every day.
  const cooldownCutoff = new Date(
    Date.now() - SOURCE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent } = await sb
    .from("agent_opportunities")
    .select("source_post_id")
    .eq("workspace_id", workspaceId)
    .gte("created_at", cooldownCutoff);
  const cooldownIds = new Set(
    (recent ?? []).map((row) => row.source_post_id as string).filter(Boolean),
  );

  const freshCutoff = new Date(
    Date.now() - FRESH_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  // Lead-magnet posts are eligible: the actor auto-selects the workspace's
  // best-fit saved lead magnet (or generates one) for a modeled giveaway
  // source, so they no longer burn a turn on a guaranteed failure.
  const { data: posts, error: postsError } = await sb
    .from("posts")
    .select(
      "id, account_id, text, post_url, viral_score, reactions, comments, posted_at, accounts(name)",
    )
    .in("account_id", accountIds)
    .eq("is_viral", true)
    .gte("posted_at", freshCutoff)
    .order("viral_score", { ascending: false })
    .limit(50);
  if (postsError) throw postsError;

  // Creator norms for the headline label ("2.3k likes" / "140 comments" /
  // "1.5× their norm" — whichever metric is the strongest outlier for THAT
  // creator). 90-day median per account over the same posts table.
  const baselineCutoff = new Date(
    Date.now() - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  // Two size-dependent failures at once. `.limit(5000)` did not lift
  // PostgREST's 1000-row cap, and a long `.in(accountIds)` can exceed the URL
  // length ceiling. A truncated read here does not error — it silently lowers
  // the 90-day baseline, so ordinary posts start reading as outliers.
  type BaselineRow = {
    account_id: string;
    reactions: number | null;
    comments: number | null;
  };
  const metricRows = await selectInChunks<BaselineRow>(accountIds, (ids) =>
    selectAllRows<BaselineRow>(() =>
      sb
        .from("posts")
        .select("account_id, reactions, comments")
        .in("account_id", ids)
        .gte("posted_at", baselineCutoff) as never,
    ).then((data) => ({ data, error: null as unknown })),
  );
  const baselines = creatorBaselinesFromRows(
    (metricRows ?? []) as Array<{
      account_id: string;
      reactions: number | null;
      comments: number | null;
    }>,
  );

  const candidates = ((posts ?? []) as AgentOpportunityPostRow[])
    .filter((row) => !cooldownIds.has(row.id))
    .filter((row) => typeof row.text === "string" && row.text.trim().length > 0)
    .map((row) => ({ row, score: scoreAgentOpportunityPost(row) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PROPOSED_PER_RUN);

  let inserted = 0;
  for (const { row, score } of candidates) {
    const { error } = await sb.from("agent_opportunities").insert({
      workspace_id: workspaceId,
      kind: "outlier",
      source_post_id: row.id,
      status: "proposed",
      score,
      payload: {
        headline: agentOpportunityHeadline(
          row,
          row.account_id ? baselines.get(row.account_id) : null,
        ),
        author: accountName(row),
        metrics: {
          viral_score: row.viral_score ?? 0,
          reactions: row.reactions ?? 0,
          comments: row.comments ?? 0,
        },
        reason: "fresh_outlier",
      },
    });
    if (error) {
      // Unique-live-source collisions are expected on concurrent runs; skip.
      if (!String(error.message).includes("duplicate key")) {
        console.warn(
          "scanAgentOpportunities insert failed:",
          error.message,
        );
      }
      continue;
    }
    inserted += 1;
  }

  return { scanned: (posts ?? []).length, inserted, expired };
}
