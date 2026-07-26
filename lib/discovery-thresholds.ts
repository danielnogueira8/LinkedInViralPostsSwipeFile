import { supabaseAdmin } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DiscoveryThresholds = {
  regular: { enabled: boolean; minLikes: number };
  leadMagnet: { enabled: boolean; minComments: number };
};

export const DEFAULT_DISCOVERY_THRESHOLDS: DiscoveryThresholds = {
  regular: { enabled: true, minLikes: 100 },
  leadMagnet: { enabled: true, minComments: 250 },
};

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function normalizeDiscoveryThresholds(value: unknown): DiscoveryThresholds {
  const input =
    value && typeof value === "object"
      ? (value as {
          regular?: { enabled?: unknown; minLikes?: unknown };
          leadMagnet?: { enabled?: unknown; minComments?: unknown };
        })
      : {};
  return {
    regular: {
      enabled:
        typeof input.regular?.enabled === "boolean"
          ? input.regular.enabled
          : DEFAULT_DISCOVERY_THRESHOLDS.regular.enabled,
      minLikes: nonNegativeInteger(
        input.regular?.minLikes,
        DEFAULT_DISCOVERY_THRESHOLDS.regular.minLikes,
      ),
    },
    leadMagnet: {
      enabled:
        typeof input.leadMagnet?.enabled === "boolean"
          ? input.leadMagnet.enabled
          : DEFAULT_DISCOVERY_THRESHOLDS.leadMagnet.enabled,
      minComments: nonNegativeInteger(
        input.leadMagnet?.minComments,
        DEFAULT_DISCOVERY_THRESHOLDS.leadMagnet.minComments,
      ),
    },
  };
}

export async function getDiscoveryThresholds(
  workspaceId: string,
  db: SupabaseClient = supabaseAdmin(),
): Promise<DiscoveryThresholds> {
  // The RPC keeps the settings table out of discovery query builders (and
  // centralizes the fallback). Lightweight query doubles without RPC support
  // receive the same public defaults.
  if (typeof db.rpc !== "function") return DEFAULT_DISCOVERY_THRESHOLDS;
  const { data, error } = await db.rpc("get_discovery_thresholds", {
    p_workspace_id: workspaceId,
  });
  if (error) throw error;
  return normalizeDiscoveryThresholds(data);
}

export function passesDiscoveryThreshold(
  post: {
    postType: string | null | undefined;
    reactions: number | null | undefined;
    comments: number | null | undefined;
  },
  thresholds: DiscoveryThresholds,
): boolean {
  if (post.postType === "lead_magnet") {
    return (
      !thresholds.leadMagnet.enabled ||
      (post.comments ?? 0) >= thresholds.leadMagnet.minComments
    );
  }
  return (
    !thresholds.regular.enabled ||
    (post.reactions ?? 0) >= thresholds.regular.minLikes
  );
}

/** Safe PostgREST `or` expression: every numeric value is normalized above. */
export function discoveryThresholdFilter(thresholds: DiscoveryThresholds): string {
  const regular = thresholds.regular.enabled
    ? `and(post_type.eq.regular,reactions.gte.${thresholds.regular.minLikes})`
    : "post_type.eq.regular";
  const leadMagnet = thresholds.leadMagnet.enabled
    ? `and(post_type.eq.lead_magnet,comments.gte.${thresholds.leadMagnet.minComments})`
    : "post_type.eq.lead_magnet";
  return `${regular},${leadMagnet}`;
}

export function discoveryThresholdChips(thresholds: DiscoveryThresholds): string[] {
  const chips: string[] = [];
  if (thresholds.regular.enabled) {
    chips.push(`Regular ≥${thresholds.regular.minLikes} likes`);
  }
  if (thresholds.leadMagnet.enabled) {
    chips.push(`Lead Magnet ≥${thresholds.leadMagnet.minComments} comments`);
  }
  return chips;
}
