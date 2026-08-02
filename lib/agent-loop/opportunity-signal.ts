export type DiscoveryAgent = "trend_radar" | "newsjacking";

export const EXTERNAL_OPPORTUNITY_KINDS = ["trend", "news"] as const;
export const TREND_RADAR_CURATION_VERSION = 2 as const;

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

/**
 * Keep pre-curation Trend Radar rows out of the inbox. Newsjacking rows have
 * their own source-verification gate and remain readable across versions.
 */
export function isDisplayableDiscoveryOpportunity(
  kind: string | null | undefined,
  payload: unknown,
): boolean {
  if (discoveryAgentForOpportunity(kind, payload) === "newsjacking") {
    return true;
  }
  const value = payload as { curation_version?: unknown } | null;
  return value?.curation_version === TREND_RADAR_CURATION_VERSION;
}
