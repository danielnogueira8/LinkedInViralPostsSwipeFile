import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { createProductionAgentInbox } from "@/lib/agent-inbox/service";
import type { AgentInboxStatus, AgentRadarIdea } from "@/lib/agent-inbox";
import { readOpportunityHeadline } from "@/lib/agent-loop/headline";
import {
  discoveryAgentForOpportunity,
  type DiscoveryAgent,
} from "@/lib/agent-loop/opportunity-signal";
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

type RadarPayload = Record<string, unknown>;

type RadarRow = {
  id: string;
  kind: string;
  status: string;
  score: number | string | null;
  payload: RadarPayload | null;
  trend_key: string | null;
  created_at: string;
  acted_at: string | null;
  snoozed_until: string | null;
  read_at: string | null;
};

function radarStatus(status: string): AgentInboxStatus {
  switch (status) {
    case "handled":
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

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

type RepresentativePost = {
  author?: unknown;
  text?: unknown;
  url?: unknown;
  posted_at?: unknown;
};

function representativePosts(payload: RadarPayload): RepresentativePost[] {
  if (!Array.isArray(payload.representative_posts)) return [];
  return payload.representative_posts.filter(
    (post): post is RepresentativePost =>
      Boolean(post) && typeof post === "object" && !Array.isArray(post),
  );
}

function radarIdeaFromRow(
  row: RadarRow,
  workspaceId: string,
  agent: DiscoveryAgent,
): AgentRadarIdea {
  const payload = row.payload ?? {};
  const isNewsjacking = agent === "newsjacking";
  const headline = readOpportunityHeadline(payload);
  const sourceName = textValue(
    payload.source_name,
    isNewsjacking ? "Verified web source" : "Monitored creator conversation",
  );
  const summary = textValue(
    payload.summary,
    isNewsjacking
      ? "A fresh development found by Newsjacking."
      : "An emerging conversation found among monitored creators.",
  );
  const sourceUrl = textValue(payload.source_url) || null;
  const publishedAt = textValue(payload.published_at) || null;
  const creatorCoverage =
    payload.creator_coverage === "observed"
      ? "Tracked creator coverage was observed at detection time."
      : "No tracked creator coverage was observed at detection time.";
  const viralMechanism = textValue(payload.viral_mechanism);
  const signalConfidence = textValue(payload.signal_confidence);
  const createdAt = row.created_at;
  const status = radarStatus(row.status);
  const sourceRef = row.trend_key ?? sourceName;
  const representatives = representativePosts(payload);
  const evidence = isNewsjacking
    ? [
        {
          kind: "news" as const,
          label: sourceName,
          detail: summary,
          url: sourceUrl,
          publishedAt,
          ref: sourceName,
        },
      ]
    : representatives.length > 0
      ? representatives.map((post, index) => ({
          kind: "source_post" as const,
          label: textValue(post.author, `Representative creator ${index + 1}`),
          detail: textValue(post.text, summary),
          url: textValue(post.url) || null,
          publishedAt: textValue(post.posted_at) || null,
          ref: textValue(post.url) || `representative-${index + 1}`,
        }))
      : [
          {
            kind: "source_post" as const,
            label: sourceName,
            detail: summary,
            url: sourceUrl,
            publishedAt,
            ref: sourceName,
          },
        ];
  const why = (
    isNewsjacking
      ? [viralMechanism, creatorCoverage, `Grounded in ${sourceName}.`]
      : [
          signalConfidence
            ? `${signalConfidence[0].toUpperCase()}${signalConfidence.slice(1)} signal.`
            : "",
          textValue(
            payload.why_now,
            "Several monitored creators are converging on this conversation.",
          ),
          viralMechanism ||
            `${representatives.length || 1} representative post${representatives.length === 1 ? "" : "s"} attached for review.`,
        ]
  ).filter(Boolean);

  return {
    id: row.id,
    workspaceId,
    lane: agent,
    radar: true,
    status,
    headline,
    angle:
      textValue(payload.angle_prompt) ||
      (isNewsjacking
        ? "Verify the dated event, open on what happened, then make one direct connection to your work."
        : "Explain what this emerging conversation changes for your audience, then add an original observation."),
    why,
    evidence,
    sourceKind: isNewsjacking ? "news" : "source_post",
    sourceRef,
    sourceUrl,
    sourceTitle: headline,
    sourcePublishedAt: publishedAt,
    score: Math.max(
      0,
      Math.min(
        1,
        isNewsjacking && Number(row.score ?? 0) > 1
          ? Number(row.score ?? 0) / 9
          : Number(row.score ?? 0),
      ),
    ),
    fingerprint: `${agent}:${row.trend_key ?? row.id}`,
    availableOn: createdAt.slice(0, 10),
    expiresAt: null,
    snoozedUntil: row.snoozed_until,
    actedAt: row.acted_at,
    discardReason:
      status === "discarded"
        ? textValue(
            payload.dismiss_reason,
            `Dismissed from ${isNewsjacking ? "Newsjacking" : "Trend Radar"}`,
          )
        : null,
    readAt: row.read_at,
    createdAt,
    updatedAt: row.acted_at ?? row.snoozed_until ?? createdAt,
  };
}

async function readRadarOpportunities(
  workspaceId: string,
  db: Awaited<ReturnType<typeof scopedSupabase>>["raw"],
): Promise<{
  trends: AgentRadarIdea[];
  trendActivity: AgentRadarIdea[];
  newsjacking: AgentRadarIdea[];
  newsjackingActivity: AgentRadarIdea[];
}> {
  const now = new Date().toISOString();
  const externalKinds = ["trend", "news"];
  const { error: releaseError } = await db
    .from("agent_opportunities")
    .update({ status: "proposed", snoozed_until: null })
    .eq("workspace_id", workspaceId)
    .in("kind", externalKinds)
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
      .in("kind", externalKinds)
      .eq("status", "proposed")
      .order("score", { ascending: false })
      .limit(40),
    db
      .from("agent_opportunities")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .in("kind", externalKinds)
      .in("status", ["handled", "drafted", "dismissed", "snoozed", "expired"])
      .order("created_at", { ascending: false })
      .limit(80),
  ]);
  if (activeResult.error) throw activeResult.error;
  if (activityResult.error) throw activityResult.error;

  const activeByAgent: Record<DiscoveryAgent, AgentRadarIdea[]> = {
    trend_radar: [],
    newsjacking: [],
  };
  const activityByAgent: Record<DiscoveryAgent, AgentRadarIdea[]> = {
    trend_radar: [],
    newsjacking: [],
  };
  for (const rawRow of activeResult.data ?? []) {
    const row = rawRow as RadarRow;
    const agent = discoveryAgentForOpportunity(row.kind, row.payload);
    activeByAgent[agent].push(radarIdeaFromRow(row, workspaceId, agent));
  }
  for (const rawRow of activityResult.data ?? []) {
    const row = rawRow as RadarRow;
    const agent = discoveryAgentForOpportunity(row.kind, row.payload);
    activityByAgent[agent].push(radarIdeaFromRow(row, workspaceId, agent));
  }
  return {
    trends: activeByAgent.trend_radar.slice(0, 3),
    trendActivity: activityByAgent.trend_radar.slice(0, 12),
    newsjacking: activeByAgent.newsjacking.slice(0, 3),
    newsjackingActivity: activityByAgent.newsjacking.slice(0, 12),
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
    const [data, radarData] = await Promise.all([
      inbox.read(sb.workspaceId, now),
      readRadarOpportunities(sb.workspaceId, sb.raw),
    ]);
    return NextResponse.json({ ok: true, ...data, ...radarData });
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
