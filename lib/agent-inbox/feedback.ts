import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAgentFeedLane,
  type AgentFeedLane,
} from "@/lib/agent-inbox";
import {
  discoveryAgentForOpportunity,
  EXTERNAL_OPPORTUNITY_KINDS,
  isExternalOpportunityKind,
} from "@/lib/agent-loop/opportunity-signal";

export const AGENT_DISCARD_REASONS = [
  "Not relevant to me",
  "Too generic",
  "I've already said this",
  "Weak proof",
  "Forced connection",
  "Not timely",
] as const;

export type AgentDiscardReason = (typeof AGENT_DISCARD_REASONS)[number];

export type AgentDismissalFeedback = {
  lane: AgentFeedLane;
  headline: string;
  reason: string;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function payload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function timestamp(value: unknown): bigint | null {
  const raw = text(value);
  if (!raw) return null;
  const precise = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (precise) {
    const year = Number(precise[1]);
    const month = Number(precise[2]);
    const day = Number(precise[3]);
    const hour = Number(precise[4]);
    const minute = Number(precise[5]);
    const second = Number(precise[6]);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      return null;
    }
    const milliseconds = Date.parse(
      `${precise[1]}-${precise[2]}-${precise[3]}T${precise[4]}:${precise[5]}:${precise[6]}${precise[8]}`,
    );
    if (Number.isFinite(milliseconds)) {
      const micros = BigInt((precise[7] ?? "").padEnd(6, "0").slice(0, 6));
      return BigInt(milliseconds) * BigInt(1_000) + micros;
    }
  }
  return null;
}

/** One feedback vocabulary and read seam for every discovery lane. */
export async function loadAgentDismissalFeedback(
  db: SupabaseClient,
  workspaceId: string,
): Promise<AgentDismissalFeedback[]> {
  const [inbox, external] = await Promise.all([
    db
      .from("agent_inbox_ideas")
      .select("lane, headline, discard_reason, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "discarded")
      .not("discard_reason", "is", null)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(40),
    db
      .from("agent_opportunities")
      .select("kind, payload, acted_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "dismissed")
      .in("kind", [...EXTERNAL_OPPORTUNITY_KINDS])
      .order("acted_at", { ascending: false, nullsFirst: false })
      .limit(40),
  ]);
  if (inbox.error) throw inbox.error;
  if (external.error) throw external.error;

  const inboxFeedback = (inbox.data ?? []).flatMap((row) => {
    if (!isAgentFeedLane(row.lane)) return [];
    const headline = text(row.headline);
    const reason = text(row.discard_reason);
    if (!headline || !reason) return [];
    return [{ lane: row.lane, headline, reason, at: timestamp(row.updated_at) }];
  });
  const externalFeedback = (external.data ?? []).flatMap((row) => {
    if (!isExternalOpportunityKind(row.kind)) return [];
    const value = payload(row.payload);
    const lane = discoveryAgentForOpportunity(row.kind, value);
    const headline = text(value.headline);
    const reason = text(value.dismiss_reason);
    if (!headline || !reason) return [];
    return [
      {
        lane,
        headline,
        reason,
        at: timestamp(row.acted_at),
      },
    ];
  });
  return [...inboxFeedback, ...externalFeedback]
    .sort((left, right) => {
      if (left.at === right.at) return 0;
      if (left.at === null) return 1;
      if (right.at === null) return -1;
      return left.at > right.at ? -1 : 1;
    })
    .slice(0, 40)
    .map(({ lane, headline, reason }) => ({ lane, headline, reason }));
}
