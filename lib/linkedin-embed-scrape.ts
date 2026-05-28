// Free, unauthenticated extraction of a LinkedIn post's full content from
// its public embed page.
//
// LinkedIn serves a server-renderable HTML page at
//   https://www.linkedin.com/embed/feed/update/<urn>
// (the same URL we put in an iframe). The "can't read it, cross-origin"
// problem only applies to the *browser* iframe — fetched server-side, the
// markup is ours to parse. It carries the full post text (not oEmbed's
// ~200-char teaser), author name, profile pic, post media, and *live*
// reaction/comment counts. No Apify credits, no login.
//
// This is HTML scraping, so it's selector-coupled: if LinkedIn changes the
// embed markup the parse degrades to nulls and the caller falls back to the
// oEmbed snippet + "open on LinkedIn". We never throw — a failed scrape
// returns an all-null result so the save flow keeps working.
//
// Selectors verified against live embeds (May 2026):
//   - text         data-test-id="main-feed-activity-embed-card__commentary"
//   - author       <img alt="View profile for <Name>">
//   - profile pic  .../profile-displayphoto-...
//   - image media  data-test-id="feed-images-content" + .../image-shrink_...
//   - video poster <video ... data-poster-url="...videocover...">
//   - reactions    data-test-id="social-actions__reaction-count"
//   - comments     data-test-id="social-actions__comments"

export type EmbedCard = {
  authorName: string | null;
  profileUrl: string | null;
  text: string | null;
  profilePicUrl: string | null;
  mediaType: "none" | "image" | "video" | "document";
  mediaUrls: string[];
  reactions: number | null;
  comments: number | null;
};

const EMPTY: EmbedCard = {
  authorName: null,
  profileUrl: null,
  text: null,
  profilePicUrl: null,
  mediaType: "none",
  mediaUrls: [],
  reactions: null,
  comments: null,
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// "47 Comments" → 47, "1,234" → 1234, "1.2K" → 1200, "3M" → 3000000.
// LinkedIn's embed renders exact counts for small numbers and abbreviated
// ones (K/M) for large posts; handle both.
function parseCount(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, "").match(/([\d.]+)\s*([KM]?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const suffix = m[2].toUpperCase();
  const mult = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : 1;
  return Math.round(n * mult);
}

function first(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * Fetch and parse the public embed page for a URN (e.g.
 * "urn:li:activity:7463197138613751808"). Returns all-null fields on any
 * failure — never throws.
 *
 * 6s timeout so a slow LinkedIn doesn't hang the save flow.
 */
export async function fetchEmbedCard(urn: string): Promise<EmbedCard> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      `https://www.linkedin.com/embed/feed/update/${urn}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LinkedInSwipeFile/1.0)",
          Accept: "text/html",
        },
        signal: controller.signal,
        cache: "no-store",
      },
    );
    clearTimeout(timeout);
    if (!res.ok) return EMPTY;
    const html = await res.text();
    return parseEmbedHtml(html);
  } catch {
    return EMPTY;
  }
}

// Split out for unit testing against saved fixtures without a network call.
export function parseEmbedHtml(html: string): EmbedCard {
  // Author name from the profile-pic alt text LinkedIn always emits.
  const authorName = first(html, /alt="View profile for ([^"]+)"/i);

  // Author profile URL (carries the handle): the actor link in the lockup.
  const profileUrl = first(
    html,
    /href="(https:\/\/www\.linkedin\.com\/in\/[^"?]+)[^"]*"[^>]*public_post_embed_feed-actor-image/i,
  );

  // Full post text. The commentary paragraph holds the entire body, not a
  // teaser. Strip inner tags (hashtag links, <br>) and collapse whitespace.
  const commentaryRaw = first(
    html,
    /data-test-id="main-feed-activity-embed-card__commentary"[^>]*>([\s\S]*?)<\/p>/i,
  );
  const text = commentaryRaw
    ? decodeEntities(
        commentaryRaw
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, ""),
      ).trim() || null
    : null;

  // Profile pic — the displayphoto image. data-delayed-url is LinkedIn's
  // lazy-load attr; the real URL lives there.
  const profilePicUrl = first(
    html,
    /(https:\/\/media\.licdn\.com\/dms\/image\/[^"\s]+profile-displayphoto[^"\s]+)/i,
  );
  const profilePic = profilePicUrl ? decodeEntities(profilePicUrl) : null;

  // Media detection. Video first (it also has no feed-images block), then
  // image. We don't attempt document/PDF carousels from the embed — those
  // are rare in bookmarks and the embed doesn't expose page images cleanly;
  // they fall through to "none" + text, still readable.
  let mediaType: EmbedCard["mediaType"] = "none";
  const mediaUrls: string[] = [];

  const posterUrl = first(html, /data-poster-url="([^"]+)"/i);
  if (html.includes("<video") && posterUrl) {
    mediaType = "video";
    mediaUrls.push(decodeEntities(posterUrl));
  } else if (html.includes('data-test-id="feed-images-content"')) {
    mediaType = "image";
    // All post images are image-shrink/image-scale URLs (NOT displayphoto).
    const imgRe =
      /(https:\/\/media\.licdn\.com\/dms\/image\/[^"\s]+image-(?:shrink|scale)[^"\s]+)/gi;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(html)) !== null) {
      const u = decodeEntities(m[1]);
      if (!seen.has(u)) {
        seen.add(u);
        mediaUrls.push(u);
      }
    }
    // If the markers said "image" but we matched nothing, drop back to none
    // so the card doesn't render a broken <img>.
    if (mediaUrls.length === 0) mediaType = "none";
  }

  const reactions = parseCount(
    first(
      html,
      /data-test-id="social-actions__reaction-count"[^>]*>([\s\S]*?)<\/span>/i,
    ),
  );
  const comments = parseCount(
    first(
      html,
      /data-test-id="social-actions__comments"[^>]*>([\s\S]*?)<\/a>/i,
    ),
  );

  return {
    authorName: authorName ? decodeEntities(authorName).trim() : null,
    profileUrl,
    text,
    profilePicUrl: profilePic,
    mediaType,
    mediaUrls,
    reactions,
    comments,
  };
}
