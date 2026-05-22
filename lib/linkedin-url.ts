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
// Author handle for the canonical profile URL: /in/<handle>/.
const PROFILE_HANDLE_RE = /linkedin\.com\/in\/([^/?#]+)/i;

/**
 * Pull the activity id out of any LinkedIn post URL we accept.
 * Returns null if the URL doesn't look like one we can handle.
 */
export function extractActivityId(url: string): string | null {
  return extractUrnFromUrl(url)?.id ?? null;
}

/**
 * Pull both the id AND the URN type the URL implies. LinkedIn's two URL
 * shapes carry *different* URN types under the hood:
 *
 *   - `urn:li:activity:<id>` URLs → activity URN
 *   - `/posts/handle_keywords-<id>-sfx`  → share URN
 *
 * They are NOT interchangeable in the embed endpoint — embedding a share id
 * as `urn:li:activity:` returns 404 (and vice versa). So we keep the type
 * info alongside the id and use it when building the embed URL later.
 */
export function extractUrnFromUrl(
  url: string,
): { id: string; type: "activity" | "share" } | null {
  if (!url) return null;
  const u = url.trim();
  const m1 = u.match(ACTIVITY_URN_RE);
  if (m1) return { id: m1[1], type: "activity" };
  const m2 = u.match(SLUG_TAIL_RE);
  if (m2) return { id: m2[1], type: "share" };
  return null;
}

/**
 * Build the LinkedIn embed iframe URL from a URN. We always know the URN
 * type at save time (from the pasted URL shape), so we never have to guess.
 */
export function embedUrlForUrn(type: "activity" | "share", id: string): string {
  return `https://www.linkedin.com/embed/feed/update/urn:li:${type}:${id}`;
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
 * Pull the handle out of a canonical LinkedIn profile URL
 * (https://www.linkedin.com/in/<handle>/). oEmbed returns this as `author_url`
 * even when the source post URL is the canonical activity URN form — giving
 * us a handle we couldn't otherwise extract from the post URL itself.
 */
export function authorHandleFromProfileUrl(url: string): string | null {
  const m = url.match(PROFILE_HANDLE_RE);
  if (!m) return null;
  return decodeURIComponent(m[1]).toLowerCase();
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
  authorProfileUrl: string | null;
  textSnippet: string | null;
  // The exact URN (e.g. "urn:li:share:7462833159877922817") that LinkedIn
  // uses in its own embed iframe. We extract this from oEmbed's `html` field
  // and store it verbatim so the embed URL we build later actually resolves.
  // Pretty-slug URLs (/posts/...) carry share URNs; canonical URLs carry
  // activity URNs — they aren't interchangeable in the embed endpoint.
  embedUrn: string | null;
};

// Matches the src attr of the iframe LinkedIn returns in oEmbed `html`:
//   <iframe src="https://www.linkedin.com/embed/feed/update/urn:li:share:...">
const EMBED_URN_RE = /\/embed\/feed\/update\/(urn:li:(?:share|activity):\d{15,20})/i;

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
  const empty: OEmbedResult = {
    authorName: null,
    authorProfileUrl: null,
    textSnippet: null,
    embedUrn: null,
  };
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
    const json = (await res.json()) as {
      title?: string;
      author_name?: string;
      author_url?: string;
      html?: string;
    };
    const text = typeof json.title === "string" ? json.title.trim() : null;
    const htmlMatch =
      typeof json.html === "string" ? json.html.match(EMBED_URN_RE) : null;
    return {
      authorName: typeof json.author_name === "string" ? json.author_name.trim() : null,
      authorProfileUrl:
        typeof json.author_url === "string" ? json.author_url.trim() : null,
      // oEmbed gives a single line; cap at 500 chars defensively in case
      // LinkedIn ever returns something larger.
      textSnippet: text ? text.slice(0, 500) : null,
      embedUrn: htmlMatch ? htmlMatch[1] : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Last-resort author lookup for the case where oEmbed fails and the URL we
 * were given is a canonical activity URN (no handle in the path). LinkedIn
 * redirects most canonical post URLs to the pretty-slug form for public
 * posts, so following one redirect usually gives us back the handle.
 *
 * Returns null if the redirect doesn't land on a /posts/<handle>_... URL —
 * which can happen for private posts, deleted posts, or rate-limited
 * lookups. The caller falls back to the existing "save with what we have"
 * behavior.
 *
 * 4s timeout — this runs in addition to the oEmbed call, so we want it
 * short enough not to compound save latency.
 */
export async function fetchHandleViaRedirect(canonicalUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(canonicalUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinkedInSwipeFile/1.0)",
        Accept: "text/html",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    // `res.url` reflects the final URL after redirects. If LinkedIn never
    // rewrote it, we get back what we sent in.
    return authorHandleFromUrl(res.url);
  } catch {
    return null;
  }
}
