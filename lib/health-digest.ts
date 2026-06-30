// ---------------------------------------------------------------------------
// Daily health digest — turns the spend/usage data we already record into a
// once-a-day summary posted to a webhook, so cost pressure and anomalies are
// SEEN (a Slack ping) instead of discovered when a workspace hits its cap or a
// surprise bill lands. Runs from the daily cron (which already has DB + a
// schedule). DB-derived on purpose: the per-turn structured logs (agent_turn,
// draft_ai_tells, …) go to Vercel stdout, which a cron can't query — usage_events
// is the reliable, queryable source of truth for cost health.
//
// The aggregation is a PURE function (summarizeUsage) over the rows, so it's
// fully unit-tested; the cron just fetches the rows, formats, and posts.
// ---------------------------------------------------------------------------

export type UsageRow = {
  workspace_id: string | null;
  cost_usd: number | null;
  kind: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
};

export type WorkspaceSpend = {
  workspaceId: string;
  spend: number; // USD this month
  pctOfCap: number; // 0..1+ (can exceed 1 if over)
  status: "ok" | "warn" | "over"; // warn at >=80% of cap, over at >=100%
};

export type UsageSummary = {
  totalSpend: number; // USD across all workspaces this month
  workspaceCount: number; // distinct workspaces with spend
  byKind: { kind: string; spend: number; calls: number }[]; // spend per call-kind
  // Workspaces at or near the cap, worst first (the actionable list).
  pressured: WorkspaceSpend[];
  budgetUsd: number;
};

// Thresholds: warn when a workspace has used >= 80% of its monthly cap.
const WARN_FRACTION = 0.8;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Aggregate a month's usage_events rows into the digest summary. Pure.
export function summarizeUsage(rows: UsageRow[], budgetUsd: number): UsageSummary {
  const perWorkspace = new Map<string, number>();
  const perKind = new Map<string, { spend: number; calls: number }>();
  let totalSpend = 0;

  for (const r of rows) {
    const cost = Number(r.cost_usd ?? 0) || 0;
    totalSpend += cost;
    if (r.workspace_id) {
      perWorkspace.set(r.workspace_id, (perWorkspace.get(r.workspace_id) ?? 0) + cost);
    }
    const kind = r.kind || "unknown";
    const k = perKind.get(kind) ?? { spend: 0, calls: 0 };
    k.spend += cost;
    k.calls += 1;
    perKind.set(kind, k);
  }

  const pressured: WorkspaceSpend[] = [];
  for (const [workspaceId, spend] of perWorkspace) {
    const pctOfCap = budgetUsd > 0 ? spend / budgetUsd : 0;
    const status: WorkspaceSpend["status"] =
      pctOfCap >= 1 ? "over" : pctOfCap >= WARN_FRACTION ? "warn" : "ok";
    if (status !== "ok") {
      pressured.push({ workspaceId, spend: round2(spend), pctOfCap, status });
    }
  }
  pressured.sort((a, b) => b.pctOfCap - a.pctOfCap);

  const byKind = [...perKind.entries()]
    .map(([kind, v]) => ({ kind, spend: round2(v.spend), calls: v.calls }))
    .sort((a, b) => b.spend - a.spend);

  return {
    totalSpend: round2(totalSpend),
    workspaceCount: perWorkspace.size,
    byKind,
    pressured,
    budgetUsd,
  };
}

// Should we send a digest at all? Always send a brief one (so the channel proves
// the cron is alive), but mark it ALERT when a workspace is at/over the cap.
export function digestIsAlert(summary: UsageSummary): boolean {
  return summary.pressured.some((w) => w.status === "over" || w.status === "warn");
}

// Format the summary as a short webhook (Slack/Discord) message. Plain text so
// it renders in either. The alert prefix makes a real problem scannable.
export function formatDigest(summary: UsageSummary, monthLabel: string): string {
  const alert = digestIsAlert(summary);
  const lines: string[] = [];
  lines.push(
    `${alert ? "⚠️ " : ""}SwipeIn daily health — ${monthLabel} so far`,
  );
  lines.push(
    `Spend: $${summary.totalSpend.toFixed(2)} across ${summary.workspaceCount} workspace(s) (cap $${summary.budgetUsd}/mo each).`,
  );
  if (summary.pressured.length > 0) {
    lines.push("Cost pressure:");
    for (const w of summary.pressured.slice(0, 10)) {
      const flag = w.status === "over" ? "🔴 OVER" : "🟡 warn";
      lines.push(
        `  ${flag} ${w.workspaceId} — $${w.spend.toFixed(2)} (${Math.round(w.pctOfCap * 100)}% of cap)`,
      );
    }
  } else {
    lines.push("No workspace near its cap. ✅");
  }
  if (summary.byKind.length > 0) {
    const top = summary.byKind
      .slice(0, 5)
      .map((k) => `${k.kind} $${k.spend.toFixed(2)}`)
      .join(", ");
    lines.push(`By kind: ${top}.`);
  }
  return lines.join("\n");
}
