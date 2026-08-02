export type DiscoveryAgent = "trend_radar" | "newsjacking";

export const EXTERNAL_OPPORTUNITY_KINDS = ["trend", "news"] as const;

export function isExternalOpportunityKind(
  kind: string | null | undefined,
): boolean {
  return kind === "trend" || kind === "news";
}

/**
 * Resolve the user-facing discovery agent at the persistence seam.
 *
 * The kind is authoritative for new rows. The payload fallbacks keep rows
 * written before migration 171 readable while old deployments drain.
 */
export function discoveryAgentForOpportunity(
  kind: string | null | undefined,
  payload: unknown,
): DiscoveryAgent {
  if (kind === "news") return "newsjacking";
  if (kind !== "trend") return "trend_radar";
  const value = payload as { signal_type?: unknown; reason?: unknown } | null;
  if (
    value?.signal_type === "newsjacking" ||
    value?.reason === "creator_independent"
  ) {
    return "newsjacking";
  }
  return "trend_radar";
}
