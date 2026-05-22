// Parsing utilities for LinkedIn post URLs.
//
// LinkedIn ships two URL shapes that both need to work:
//
//  1. Canonical activity URN
//     https://www.linkedin.com/feed/update/urn:li:activity:7427236756741287936/
//
//  2. Pretty slug (what the share button copies)
//     https://www.linkedin.com/posts/naman-jain-458946388_linkedinbanner-linkedingrowth-...
//       -7427236755713441792-B2kj?utm_source=...
//
// Both embed the activity id — a 15-20 digit integer — and that id is our
// dedupe key. Two users pasting different shapes for the same post should
// upsert into the same `saved_posts` row.
//
// Note: the activity id in shape (2) is *not* always identical to the one
// in shape (1) — LinkedIn sometimes uses a related "share urn" id that
// resolves to the same post but isn't byte-equal. We treat whatever we
// extract as canonical for dedupe purposes within our system, since we
// can't introspect LinkedIn's mapping without authenticating.

const ACTIVITY_URN_RE = /urn:li:activity:(\d{15,20})/i;
// In the pretty slug, the activity id is the digit-run between the last
// dash and the 4-char suffix at the end of the path: `...-<digits>-<sfx>`.
// We anchor on the trailing `-<4-12 alnum>(?:/|\?|$)` to avoid matching
// digits inside the keyword segment.
const SLUG_TAIL_RE = /-(\d{15,20})-[A-Za-z0-9_-]{1,12}\/?(?:\?|#|$)/;
// Author handle for the pretty slug: the segment between /posts/ and the
// first underscore.
const POSTS_HANDLE_RE = /\/posts\/([^_/?#]+)_/i;

/**
 * Pull the activity id out of any LinkedIn post URL we accept.
 * Returns null if the URL doesn't look like one we can handle.
 */
export function extractActivityId(url: string): string | null {
  if (!url) return null;
  const u = url.trim();
  const m1 = u.match(ACTIVITY_URN_RE);
  if (m1) return m1[1];
  const m2 = u.match(SLUG_TAIL_RE);
  if (m2) return m2[1];
  return null;
}

/**
 * Build the canonical /feed/update/urn:li:activity:.../ URL from an activity
 * id. We always store this as `post_url` so the "Open on LinkedIn" link
 * works the same regardless of which shape the user originally pasted.
 */
export function canonicalPostUrl(activityId: string): string {
  return `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
}

/**
 * Pull the author handle from a pretty-slug URL. Returns null for
 * /feed/update/... URLs (those don't carry the handle in the path).
 */
export function authorHandleFromUrl(url: string): string | null {
  const m = url.match(POSTS_HANDLE_RE);
  if (!m) return null;
  // Strip the trailing numeric suffix LinkedIn adds to disambiguate handles
  // (e.g. "naman-jain-458946388" → "naman-jain"). Keep both around — the
  // suffix is a stable identifier, the prefix is the human display name.
  return m[1].toLowerCase();
}

/**
 * Best-effort display name from a handle: "naman-jain-458946388" → "Naman Jain".
 * Used only when oEmbed doesn't return an author_name.
 */
export function displayNameFromHandle(handle: string): string {
  return handle
    // drop the trailing numeric disambiguator
    .replace(/-\d+$/, "")
    .split("-")
    .map((w) => (w.length === 0 ? "" : w[0].toUpperCase() + w.slice(1)))
    .filter(Boolean)
    .join(" ");
}

export type OEmbedResult = {
  authorName: string | null;
  textSnippet: string | null;
};

/**
 * Fetch LinkedIn's public oEmbed endpoint for a post URL. Returns whatever
 * we can extract, or `null` fields if LinkedIn blocks/rate-limits us. This
 * is free and unauthenticated — no Apify credits used.
 *
 * Notable: LinkedIn's oEmbed returns:
 *   - `title`         → usually the post's first ~150-300 chars of text
 *   - `author_name`   → author display name
 *   - `html`          → an iframe embed (we ignore — engagement is inside it
 *                       and unreadable due to cross-origin restrictions)
 *
 * 6s timeout so a slow LinkedIn doesn't hang the save flow. On any failure
 * we return nulls and let the caller fall back to handle-derived data.
 */
export async function fetchOEmbed(canonicalUrl: string): Promise<OEmbedResult> {
  const empty: OEmbedResult = { authorName: null, textSnippet: null };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      `https://www.linkedin.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
      {
        headers: {
          // Some LinkedIn endpoints 403 requests without a UA. Keep it generic.
          "User-Agent": "Mozilla/5.0 (compatible; LinkedInSwipeFile/1.0)",
          Accept: "application/json",
        },
        signal: controller.signal,
        // Don't cache — LinkedIn occasionally returns stale "share unavailable"
        // payloads on cached lookups.
        cache: "no-store",
      },
    );
    clearTimeout(timeout);
    if (!res.ok) return empty;
    const json = (await res.json()) as { title?: string; author_name?: string };
    const text = typeof json.title === "string" ? json.title.trim() : null;
    return {
      authorName: typeof json.author_name === "string" ? json.author_name.trim() : null,
      // oEmbed gives a single line; cap at 500 chars defensively in case
      // LinkedIn ever returns something larger.
      textSnippet: text ? text.slice(0, 500) : null,
    };
  } catch {
    return empty;
  }
}
