import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { createProductionAgentInbox } from "@/lib/agent-inbox/service";
import type { AgentInboxStatus, AgentRadarIdea } from "@/lib/agent-inbox";
import { readOpportunityHeadline } from "@/lib/agent-loop/headline";
import type { TrendOpportunityPayload } from "@/lib/agent-loop/trend-radar";
import { saveAgentInboxPreferences } from "@/lib/agent-inbox/supabase";
import { errorResponse } from "@/lib/workspace";
import { isDueNow } from "@/lib/agent-inbox/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const preferencesSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().min(1).max(100),
  deliveryLocalTime: z.string().regex(/^\d{2}:\d{2}$/),
  topics: z.array(z.string().trim().min(1).max(80)).max(10),
  newsSensitivity: z.enum(["low", "standard", "high"]),
});

type TrendRow = {
  id: string;
  kind: string;
  status: string;
  score: number | string | null;
  payload: TrendOpportunityPayload | null;
  trend_key: string | null;
  created_at: string;
  acted_at: string | null;
  snoozed_until: string | null;
  read_at: string | null;
};

function trendStatus(status: string): AgentInboxStatus {
  switch (status) {
    case "handled":
      return "acted";
    case "drafted":
      return "acted";
    case "dismissed":
      return "discarded";
    case "snoozed":
      return "snoozed";
    case "expired":
      return "expired";
    default:
      return "active";
  }
}

function trendIdeaFromRow(
  row: TrendRow,
  workspaceId: string,
): AgentRadarIdea {
  const payload = row.payload ?? {};
  const headline = readOpportunityHeadline(payload);
  const textValue = (value: unknown, fallback = ""): string =>
    typeof value === "string" ? value.trim() || fallback : fallback;
  const sourceName = textValue(payload.source_name, "Verified web source");
  const summary = textValue(
    payload.summary,
    "A fresh development found by Trend Radar.",
  );
  const sourceUrl = textValue(payload.source_url) || null;
  const publishedAt = textValue(payload.published_at) || null;
  const creatorCoverage =
    payload.creator_coverage === "observed"
      ? "Tracked creator coverage was observed at detection time."
      : "No tracked creator coverage was observed at detection time.";
  const createdAt = row.created_at;
  const status = trendStatus(row.status);
  const sourceRef = row.trend_key ?? sourceName;
  return {
    id: row.id,
    workspaceId,
    lane: "trend_radar",
    radar: true,
    status,
    headline,
    angle:
      textValue(payload.angle_prompt) ||
      "Use the verified development as the opening, then add one specific implication for your audience.",
    why: [creatorCoverage, `Grounded in ${sourceName}.`],
    evidence: [
      {
        kind: "news",
        label: sourceName,
        detail: summary,
        url: sourceUrl,
        publishedAt,
        ref: sourceName,
      },
    ],
    sourceKind: "news",
    sourceRef,
    sourceUrl,
    sourceTitle: headline,
    sourcePublishedAt: publishedAt,
    score: Math.max(0, Math.min(1, Number(row.score ?? 0) / 9)),
    fingerprint: `trend:${row.trend_key ?? row.id}`,
    availableOn: createdAt.slice(0, 10),
    expiresAt: null,
    snoozedUntil: row.snoozed_until,
    actedAt: row.acted_at,
    discardReason: status === "discarded" ? "Dismissed from Trend Radar" : null,
    readAt: row.read_at,
    createdAt,
    updatedAt: row.acted_at ?? row.snoozed_until ?? createdAt,
  };
}

async function readTrendRadar(
  workspaceId: string,
  db: Awaited<ReturnType<typeof scopedSupabase>>["raw"],
): Promise<{ trends: AgentRadarIdea[]; trendActivity: AgentRadarIdea[] }> {
  const now = new Date().toISOString();
  const { error: releaseError } = await db
    .from("agent_opportunities")
    .update({ status: "proposed", snoozed_until: null })
    .eq("workspace_id", workspaceId)
    .eq("kind", "trend")
    .eq("status", "snoozed")
    .lte("snoozed_until", now);
  if (releaseError) throw releaseError;

  const columns =
    "id, kind, status, score, payload, trend_key, created_at, acted_at, snoozed_until, read_at";
  const [activeResult, activityResult] = await Promise.all([
    db
      .from("agent_opportunities")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .eq("kind", "trend")
      .eq("status", "proposed")
      .order("score", { ascending: false })
      .limit(3),
    db
      .from("agent_opportunities")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .eq("kind", "trend")
      .in("status", ["handled", "drafted", "dismissed", "snoozed", "expired"])
      .order("created_at", { ascending: false })
      .limit(12),
  ]);
  if (activeResult.error) throw activeResult.error;
  if (activityResult.error) throw activityResult.error;
  return {
    trends: ((activeResult.data ?? []) as TrendRow[]).map((row) =>
      trendIdeaFromRow({ ...row, status: "proposed" }, workspaceId),
    ),
    trendActivity: (activityResult.data ?? []).map((row) =>
      trendIdeaFromRow(row as TrendRow, workspaceId),
    ),
  };
}

export async function GET(request: Request) {
  try {
    const sb = await scopedSupabase();
    const inbox = createProductionAgentInbox(sb.raw);
    const now = new Date();
    const initial = await inbox.read(sb.workspaceId, now);
    const wantsRecovery =
      new URL(request.url).searchParams.get("replenish") === "1";
    // The nav badge uses the plain read path. Only the Agent Inbox page opts
    // into this recovery path, and only once the configured daily delivery
    // time has arrived. The daily claim keeps refreshes idempotent.
    if (
      wantsRecovery &&
      isDueNow(
        now,
        initial.preferences.timezone,
        initial.preferences.deliveryLocalTime,
      )
    ) {
      await inbox.replenish({
        workspaceId: sb.workspaceId,
        now,
        timezone: initial.preferences.timezone,
      });
    }
    const [data, trendData] = await Promise.all([
      inbox.read(sb.workspaceId, now),
      readTrendRadar(sb.workspaceId, sb.raw),
    ]);
    return NextResponse.json({ ok: true, ...data, ...trendData });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const sb = await scopedSupabase();
    const parsed = preferencesSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Check the Agent settings and try again." },
        { status: 400 },
      );
    }
    await saveAgentInboxPreferences(sb.raw, sb.workspaceId, parsed.data);
    return NextResponse.json({ ok: true, preferences: parsed.data });
  } catch (error) {
    return errorResponse(error);
  }
}
