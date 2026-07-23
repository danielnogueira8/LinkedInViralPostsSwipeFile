import type { PostCardRow } from "@/lib/post-card-row";
import { normalizePostType } from "@/lib/post-type";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object"
    ? (value as UnknownRecord)
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Shape an untrusted Supabase posts row for the shared Swipe File card.
 * Agent opportunities are long-lived, so nullable legacy fields and deleted
 * relationships are normalized here instead of leaking card-specific guards
 * into the API route or client.
 */
export function normalizeAgentSourcePost(
  value: unknown,
): PostCardRow | null {
  const row = record(value);
  if (!row || typeof row.id !== "string") return null;

  const joinedAccount = Array.isArray(row.accounts)
    ? row.accounts[0]
    : row.accounts;
  const account = record(joinedAccount);
  const accounts =
    account &&
    typeof account.name === "string" &&
    typeof account.linkedin_handle === "string"
      ? {
          name: account.name,
          niche: nullableString(account.niche),
          linkedin_handle: account.linkedin_handle,
          profile_pic_url: nullableString(account.profile_pic_url),
          viral_post_count: count(account.viral_post_count),
          total_post_count: count(account.total_post_count),
        }
      : null;

  const visualKind =
    row.visual_kind === "photo" || row.visual_kind === "graphic"
      ? row.visual_kind
      : null;
  const viralBasis =
    row.viral_basis === "relative" ||
    row.viral_basis === "flat_fallback" ||
    row.viral_basis === "below_floor"
      ? row.viral_basis
      : null;

  return {
    id: row.id,
    text: nullableString(row.text),
    post_url: nullableString(row.post_url),
    posted_at: nullableString(row.posted_at),
    reactions: count(row.reactions),
    comments: count(row.comments),
    reposts: count(row.reposts),
    media_type:
      typeof row.media_type === "string" ? row.media_type : "none",
    media_urls: Array.isArray(row.media_urls)
      ? row.media_urls.filter(
          (url): url is string => typeof url === "string" && url.length > 0,
        )
      : [],
    visual_kind: visualKind,
    viral_score:
      typeof row.viral_score === "number" ? row.viral_score : null,
    viral_basis: viralBasis,
    baseline_score:
      typeof row.baseline_score === "number" ? row.baseline_score : null,
    post_type: normalizePostType(row.post_type) ?? "regular",
    accounts,
  };
}
