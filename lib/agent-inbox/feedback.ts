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

/** One feedback vocabulary and read seam for every discovery lane. */
export async function loadAgentDismissalFeedback(
  db: SupabaseClient,
  workspaceId: string,
): Promise<AgentDismissalFeedback[]> {
  const [inbox, external] = await Promise.all([
    db
      .from("agent_inbox_ideas")
      .select("lane, headline, discard_reason")
      .eq("workspace_id", workspaceId)
      .eq("status", "discarded")
      .not("discard_reason", "is", null)
      .order("updated_at", { ascending: false })
      .limit(30),
    db
      .from("agent_opportunities")
      .select("kind, payload")
      .eq("workspace_id", workspaceId)
      .eq("status", "dismissed")
      .in("kind", [...EXTERNAL_OPPORTUNITY_KINDS])
      .order("acted_at", { ascending: false })
      .limit(30),
  ]);
  if (inbox.error) throw inbox.error;
  if (external.error) throw external.error;

  const inboxFeedback = (inbox.data ?? []).flatMap((row) => {
    if (!isAgentFeedLane(row.lane)) return [];
    const headline = text(row.headline);
    const reason = text(row.discard_reason);
    if (!headline || !reason) return [];
    return [{ lane: row.lane, headline, reason }];
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
      },
    ];
  });
  return [...inboxFeedback, ...externalFeedback].slice(0, 40);
}
