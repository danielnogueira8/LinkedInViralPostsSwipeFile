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
// Share URN — harvestapi's post_url is /feed/update/urn:li:share:<id>.
// Must be matched explicitly: the activity regex won't catch it, and the
// slug regex only matches the /posts/...-id-sfx pretty form.
const SHARE_URN_RE = /urn:li:share:(\d{15,20})/i;
// ugcPost URN — harvestapi's shareLinkedinUrl is /feed/update/urn:li:ugcPost:<id>
// for many posts. Matched explicitly like share.
const UGCPOST_URN_RE = /urn:li:ugcPost:(\d{15,20})/i;
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
 * Pull the id and a best-guess URN type from the URL.
 *
 * IMPORTANT: the URN type from URL shape is NOT reliable. We previously
 * assumed /posts/ → share and /feed/update/ → activity, but in practice
 * the embed endpoint accepts only one of the two URN types per post, and
 * which one varies — even between two /posts/ URLs. The type field is now
 * only used as a starting guess for the probe; the probe is authoritative.
 */
export type UrnType = "activity" | "share" | "ugcPost";

export function extractUrnFromUrl(
  url: string,
): { id: string; type: UrnType } | null {
  if (!url) return null;
  const u = url.trim();
  const m1 = u.match(ACTIVITY_URN_RE);
  if (m1) return { id: m1[1], type: "activity" };
  // Explicit share URN (e.g. harvestapi's /feed/update/urn:li:share:<id>).
  const ms = u.match(SHARE_URN_RE);
  if (ms) return { id: ms[1], type: "share" };
  // Explicit ugcPost URN (harvestapi's other feed-URL form).
  const mu = u.match(UGCPOST_URN_RE);
  if (mu) return { id: mu[1], type: "ugcPost" };
  const m2 = u.match(SLUG_TAIL_RE);
  if (m2) return { id: m2[1], type: "share" };
  return null;
}

/**
 * Build the LinkedIn embed iframe URL from a URN type and id.
 */
export function embedUrlForUrn(type: UrnType, id: string): string {
  return `https://www.linkedin.com/embed/feed/update/urn:li:${type}:${id}`;
}

/**
 * Probe LinkedIn's embed endpoint for each URN type and return the one that
 * resolves (HTTP 200/206). Returns null if none resolve — likely a private
 * or deleted post.
 *
 * The embed endpoint accepts exactly one of the URN types per post, but which
 * one is opaque: it's not derivable from the URL shape, nor reliably present
 * in oEmbed's response (which often returns HTML instead of JSON). Probing is
 * the only deterministic way to find out.
 *
 * IMPORTANT — probe SEQUENTIALLY, not in parallel. Firing all three candidate
 * URLs at once makes LinkedIn see a 3-request burst and rate-limit (HTTP 429)
 * *every* candidate — including the one that would have returned 200 on its
 * own. That silently turned resolvable posts into blank bookmarks (no URN →
 * no text/media). We try one at a time, stop at the first hit, and order the
 * candidates by real-world likelihood (share first: it's what /posts/ pretty
 * slugs carry, which is the most-pasted shape).
 *
 * 429 is a soft failure (we're being throttled), not a "wrong URN" signal, so
 * on a 429 we briefly back off before the next candidate rather than blasting
 * straight through and getting throttled again.
 */
const PROBE_CANDIDATES = ["share", "activity", "ugcPost"] as const;

async function probeOne(type: (typeof PROBE_CANDIDATES)[number], id: string): Promise<"hit" | "miss" | "throttled"> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    // GET with Range: bytes=0-0 instead of HEAD. Some CDNs and edge configs
    // return 405 for HEAD on iframe endpoints; range-GET gives the same
    // status signal (200/206 vs 404) with an essentially empty body.
    const res = await fetch(embedUrlForUrn(type, id), {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinkedInSwipeFile/1.0)",
        Range: "bytes=0-0",
      },
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
    });
    await res.body?.cancel();
    clearTimeout(timeout);
    if (res.ok) return "hit";
    if (res.status === 429) return "throttled";
    return "miss";
  } catch {
    return "miss";
  }
}

export async function probeEmbedUrn(id: string): Promise<string | null> {
  for (let i = 0; i < PROBE_CANDIDATES.length; i++) {
    const type = PROBE_CANDIDATES[i];
    let outcome = await probeOne(type, id);
    // If throttled, back off once and retry this same candidate — a 429 tells
    // us nothing about whether this URN is correct, so we mustn't skip it.
    if (outcome === "throttled") {
      await new Promise((r) => setTimeout(r, 600));
      outcome = await probeOne(type, id);
    }
    if (outcome === "hit") return `urn:li:${type}:${id}`;
  }
  return null;
}

/**
 * Build the canonical /feed/update/urn:li:activity:.../ URL from an activity
 * id. We always store this as `post_url` so the "Open on LinkedIn" link
 * works the same regardless of which shape the user originally pasted.
 *
 * NOTE: only safe when the id is genuinely an `activity` id. Posts pasted as a
 * share/ugcPost URN carry a DIFFERENT id that does NOT resolve under
 * urn:li:activity — use `postUrlForUrn` with the actual URN type for those.
 * Prefer `postUrlFromUrn(embedUrn)` once we've probed the real URN.
 */
export function canonicalPostUrl(activityId: string): string {
  return `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
}

/**
 * Build a /feed/update/ post URL for an explicit URN type + id. LinkedIn
 * serves all three URN types under the same /feed/update/urn:li:<type>:<id>/
 * path, so this resolves regardless of whether the post is an activity, share,
 * or ugcPost — unlike `canonicalPostUrl`, which hardcodes `activity`.
 */
export function postUrlForUrn(type: UrnType, id: string): string {
  return `https://www.linkedin.com/feed/update/urn:li:${type}:${id}/`;
}

/**
 * Build a post URL from a full URN string ("urn:li:share:123..."), such as the
 * one we store in `embed_urn` after probing. Returns null if the string isn't
 * a URN we recognize. This is the most reliable "Open on LinkedIn" link: the
 * URN was verified to resolve at the embed endpoint, and we preserve its type
 * rather than guessing `activity`.
 */
export function postUrlFromUrn(urn: string | null | undefined): string | null {
  if (!urn) return null;
  const m = urn.match(/^urn:li:(activity|share|ugcPost):(\d{15,20})$/i);
  if (!m) return null;
  return postUrlForUrn(m[1] as UrnType, m[2]);
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

/**
 * Decode the post's publish time from a LinkedIn activity/share/ugcPost id.
 *
 * These numeric ids are Twitter-style snowflakes: the high bits hold a
 * Unix-millisecond timestamp and the low 22 bits are a per-node sequence.
 * Shifting right by 22 recovers the creation time — no network call, and it
 * works for every post we've ever saved since we already store `activity_id`.
 *
 * Returns an ISO-8601 string (UTC) or null when the id isn't a plausible
 * 15-20 digit numeric id, or the decoded time falls outside a sane window
 * (LinkedIn launched in 2003; anything before that or far in the future means
 * we mis-parsed something that isn't really a snowflake).
 */
export function postedAtFromLinkedInId(
  id: string | null | undefined,
): string | null {
  if (!id || !/^\d{15,20}$/.test(id)) return null;
  let ms: number;
  try {
    // High bits = Unix-ms timestamp; low 22 bits = per-node sequence. Dividing
    // by 2^22 (4194304) drops the sequence — same result as `>> 22` but without
    // a BigInt literal, which our ES2017 target rejects.
    ms = Number(BigInt(id) / BigInt(4194304));
  } catch {
    return null;
  }
  // Sanity window: 2003-01-01 (LinkedIn's launch) … now + 1 day of clock skew.
  const MIN = 1041379200000; // 2003-01-01T00:00:00Z
  const MAX = Date.now() + 24 * 60 * 60 * 1000;
  if (ms < MIN || ms > MAX) return null;
  return new Date(ms).toISOString();
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
// Includes ugcPost — LinkedIn embeds some posts under that URN, and #122
// taught the rest of the pipeline about it; this regex was missed.
const EMBED_URN_RE = /\/embed\/feed\/update\/(urn:li:(?:share|activity|ugcPost):\d{15,20})/i;

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

/**
 * Fetch a LinkedIn member's profile photo URL from just their profile URL —
 * free, no Apify, no login.
 *
 * Why this works when a plain fetch doesn't: LinkedIn hard-blocks generic
 * scrapers on profile pages (HTTP 999 with a stub body) but *does* serve the
 * full server-rendered page — including OpenGraph tags — to recognized
 * link-preview crawlers. Presenting a `facebookexternalhit` User-Agent (the
 * same one Facebook/Slack/etc. use to render a link card) gets us a 200 with
 * an `<meta property="og:image">` whose content is the member's
 * profile-displayphoto URL. Verified live across multiple profiles.
 *
 * This is the same avatar the daily Apify sync eventually backfills from the
 * member's posts; doing it here just means a manually-added creator shows
 * their photo immediately instead of waiting up to 24h for the next sync.
 *
 * Selector-coupled and best-effort: returns null on any failure (block,
 * timeout, markup change, private profile) so the caller saves the creator
 * regardless — the sync will still fill the pic later.
 *
 * 5s timeout so a slow/blocked LinkedIn doesn't hang the add flow.
 */
export async function fetchProfilePicUrl(profileUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(profileUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        // Crawler UA — see doc comment. A normal UA gets a 999 block.
        "User-Agent":
          "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        Accept: "text/html",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
    );
    if (!m) return null;
    // og:image content is HTML-attribute-encoded (e.g. `&amp;` between query
    // params); decode so the saved URL actually loads.
    const url = m[1]
      .replace(/&amp;/g, "&")
      .replace(/&#x2F;/g, "/")
      .trim();
    // Sanity-check it's actually a profile photo and not some fallback OG
    // banner LinkedIn occasionally serves for blocked/empty pages.
    if (!/profile-displayphoto/i.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}
