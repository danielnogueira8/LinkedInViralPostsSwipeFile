import { NextResponse } from "next/server";
import { postCronAlert } from "@/lib/cron-alert";
import { errorResponse } from "@/lib/workspace";
import { refreshPostAnalytics } from "@/lib/post-analytics";
import { supabaseAdmin } from "@/lib/supabase";
import {
  enqueueScrapeJob,
  SCRAPE_ACTIVE_WINDOW_MS,
} from "@/lib/scrape-jobs";
import {
  summarizeUsage,
  formatDigest,
  type UsageRow,
} from "@/lib/health-digest";

export const runtime = "nodejs";
export const maxDuration = 60;

// Post a daily cost/health digest to a webhook (Slack/Discord) so cost pressure
// is SEEN, not discovered at the cap. Best-effort: any failure is logged and
// swallowed — the digest must never break the scrape cron. No-ops when no
// webhook is configured.
async function postHealthDigest(): Promise<void> {
  const webhook = process.env.HEALTH_DIGEST_WEBHOOK;
  if (!webhook) return;
  try {
    const sb = supabaseAdmin();
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const budget = Number(process.env.CHAT_MONTHLY_BUDGET_USD || 5);
    const { data, error } = await sb
      .from("usage_events")
      .select("workspace_id, cost_usd, kind, input_tokens, output_tokens")
      .gte("ts", monthStart);
    if (error) throw error;
    const summary = summarizeUsage((data ?? []) as UsageRow[], budget);
    const monthLabel = now.toLocaleString("en-US", {
      month: "long",
      timeZone: "UTC",
    });
    const text = formatDigest(summary, monthLabel);
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error("health digest failed", (e as Error).message);
  }
}

export async function GET(req: Request) {
  // Require CRON_SECRET to be configured — without it the endpoint was
  // wide open (the old guard only rejected when secret was *set and wrong*).
  // Anyone hitting this endpoint can trigger a full scrape, burning Apify
  // and Anthropic credits, so fail closed when the env var is missing.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const sb = supabaseAdmin();

    // Daily cost/health digest → webhook. Fire first + independently of the
    // scrape so it posts even when a scrape is already in progress (the early
    // return below). Best-effort; never throws.
    await postHealthDigest();

    // Prune the "Model this post" handoff table — these are transient (one row
    // per click, consumed seconds later by the chat). Delete anything older than
    // a day so it doesn't grow unbounded. Best-effort; don't fail the cron on it.
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      await sb.from("chat_modeling_sources").delete().lt("created_at", dayAgo);
    } catch (e) {
      console.error("model-source prune failed", (e as Error).message);
    }

    // Daily post-analytics snapshot (Zernio → post_analytics). Best-effort:
    // an analytics hiccup must never block the day's scrape.
    try {
      const summary = await refreshPostAnalytics();
      console.log(JSON.stringify({ post_analytics_refresh: summary }));
    } catch (e) {
      console.error("post-analytics refresh failed", (e as Error).message);
    }

    // Inflight window matches our maxDuration cap (800s ≈ 14 min) plus
    // headroom. The old 30-min threshold was both too generous (lets a
    // hung run block crons for 30 min) and too tight (a legitimate 35-min
    // scrape would race a second cron). Pair it with a stuck-run sweep
    // that marks anything older than the window as `error` so future
    // crons aren't blocked forever after a crash.
    const cutoff = new Date(Date.now() - SCRAPE_ACTIVE_WINDOW_MS).toISOString();
    await sb
      .from("runs")
      .update({
        status: "error",
        finished_at: new Date().toISOString(),
        error: "stuck: marked failed by cron sweep (exceeded inflight window)",
      })
      .eq("status", "running")
      .is("workspace_id", null)
      .lt("started_at", cutoff);

    const { data: inflight } = await sb
      .from("runs")
      .select("id, started_at")
      .eq("status", "running")
      .is("workspace_id", null)
      .gte("started_at", cutoff)
      .limit(1);
    if (inflight && inflight.length > 0) {
      return NextResponse.json({ ok: true, skipped: "run_in_progress", runId: inflight[0].id });
    }

    const queued = await enqueueScrapeJob({ workspaceId: null, sb });
    if (queued.alreadyRunning) {
      return NextResponse.json({ ok: true, skipped: "run_in_progress", runId: queued.runId });
    }
    return NextResponse.json({
      ok: true,
      queued: true,
      runId: queued.runId,
      jobId: queued.jobId,
    });
  } catch (e) {
    console.error("daily cron failed", (e as Error).message);
    await postCronAlert({ cron: "daily" }, e);
    return errorResponse(e);
  }
}
