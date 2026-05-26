export type ScrapedPost = {
  linkedin_post_id: string;
  post_url: string | null;
  posted_at: string | null;
  text: string | null;
  reactions: number;
  comments: number;
  reposts: number;
  media_type: "none" | "image" | "video" | "document";
  media_urls: string[];
  // For PDF document carousels: LinkedIn's manifest URL (lists every page
  // image, two hops in) + the total page count. Null for non-documents.
  // The URL is short-lived; the full deck is resolved on demand and falls
  // back to media_urls (the cover pages) when it expires.
  document_manifest_url: string | null;
  document_page_count: number | null;
  author_handle: string | null;
  author_profile_pic_url: string | null;
  author_headline: string | null;
};

// Default actor is harvestapi (no-cookies, $0.002/post — 60% cheaper than
// the old apimaestro actor at $0.005). Override with APIFY_ACTOR_ID to flip
// back to "apimaestro~linkedin-profile-posts" if harvestapi ever misbehaves;
// the input builder + normalizePost handle both output shapes.
const ACTOR = process.env.APIFY_ACTOR_ID || "harvestapi~linkedin-profile-posts";

// Which input/output convention to use. harvestapi takes targetUrls + maxPosts
// and returns {content, engagement, shareUrn, postImages, author:{...}}.
// apimaestro takes {username, limit, page_number} and returns
// {text, stats, urn/full_urn, media, author:{username,...}}.
function isHarvestApi(): boolean {
  return ACTOR.startsWith("harvestapi");
}

function token(): string {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) throw new Error("APIFY_API_TOKEN not set");
  return t;
}

import { logApifyUsage } from "./usage";

export async function runOneProfile(username: string): Promise<unknown[]> {
  // scrape-gating reads usage_events.meta.username case-insensitively to
  // decide cadence. The current callers all pass linkedin_handle (already
  // lowercased), but normalizing here is cheap defense-in-depth — anyone
  // who calls this with mixed case in the future won't silently break
  // cadence gating (which would re-scrape the creator on every run).
  const handle = username.toLowerCase();
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token()}`;
  // Input shape differs per actor:
  //   harvestapi → { targetUrls: ["https://www.linkedin.com/in/<handle>/"], maxPosts, includeReposts }
  //   apimaestro → { username, limit, page_number }
  // We only ever want the single most-recent ORIGINAL post per creator, so
  // maxPosts:1 and includeReposts:false (a repost isn't the creator's own
  // content — we'd misattribute engagement otherwise).
  const body = isHarvestApi()
    ? {
        targetUrls: [`https://www.linkedin.com/in/${handle}/`],
        maxPosts: 1,
        includeReposts: false,
        includeQuotePosts: false,
        scrapeReactions: false,
        scrapeComments: false,
      }
    : { username: handle, limit: 1, page_number: 1 };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Failed call — log a zero-cost attempt so it shows up in the audit trail
    logApifyUsage("profile_posts_fail", 0, { username: handle, status: res.status });
    throw new Error(`Apify ${res.status} for ${handle}`);
  }
  const items = (await res.json()) as unknown[];
  const arr = Array.isArray(items) ? items : [];
  const filtered = arr.filter((it) => {
    if (!it || typeof it !== "object") return false;
    const o = it as Record<string, unknown>;
    // apimaestro sometimes returns an error object ({message:"No profile..."}
    // with no urn) inside the array — drop those. harvestapi returns clean
    // post items or an empty array, so this filter is a no-op for it.
    if (typeof o.message === "string" && !o.urn && !o.full_urn && !o.shareUrn) return false;
    return true;
  });
  // apimaestro/linkedin-profile-posts is pay-per-result at $5/1000 posts.
  // Count every billable result returned (filtered count). Failed lookups
  // ("No profile found") get filtered out above and aren't billed.
  logApifyUsage("profile_posts", filtered.length, {
    username: handle, items: filtered.length, raw_items: arr.length,
  });
  filtered.forEach((it) => { (it as Record<string, unknown>).__username = handle; });
  return filtered;
}

async function runOne(username: string): Promise<unknown[]> {
  return runOneProfile(username);
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = e as R; }
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runProfilePostsScrape(usernames: string[]): Promise<{ runId: string; items: unknown[] }> {
  // Catch per-username so `pool` always receives a fulfilled value (an empty
  // array on failure). Without this, the generic pool's catch-and-coerce
  // (`out[idx] = e as R`) would silently inject an Error object into the
  // results — the subsequent `if (Array.isArray(r))` filter would drop it,
  // and the username's failure would vanish without telemetry. Now we log
  // each failure explicitly so debugging stays possible.
  const results = await pool(usernames, 8, async (u) => {
    try {
      const items = await runOne(u);
      return items.map((it) => {
        if (it && typeof it === "object") (it as Record<string, unknown>).__username = u;
        return it;
      });
    } catch (e) {
      console.error(`[apify] profile_posts failed for ${u}:`, (e as Error).message);
      return [] as unknown[];
    }
  });
  const items: unknown[] = [];
  for (const r of results) if (Array.isArray(r)) items.push(...r);
  return { runId: `fanout-${Date.now()}`, items };
}

function toInt(v: unknown): number {
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "string") { const n = parseInt(v.replace(/[^\d-]/g, ""), 10); return isNaN(n) ? 0 : n; }
  return 0;
}

function pickMedia(item: Record<string, unknown>): { media_type: "none" | "image" | "video" | "document"; media_urls: string[] } {
  const urls: string[] = [];
  const m = item.media;
  let type: "none" | "image" | "video" | "document" = "none";

  const collectFromObj = (o: Record<string, unknown>) => {
    if (typeof o.url === "string") urls.push(o.url);
    if (Array.isArray(o.images)) {
      for (const im of o.images) {
        if (typeof im === "string") urls.push(im);
        else if (im && typeof im === "object" && typeof (im as Record<string, unknown>).url === "string") urls.push((im as Record<string, unknown>).url as string);
      }
    }
    if (Array.isArray(o.urls)) for (const u of o.urls) if (typeof u === "string") urls.push(u);
  };

  if (m && typeof m === "object") {
    const mo = m as Record<string, unknown>;
    if (typeof mo.type === "string") {
      const t = (mo.type as string).toLowerCase();
      if (t.includes("video")) type = "video";
      else if (t.includes("image")) type = "image";
      else if (t.includes("document") || t.includes("pdf") || t.includes("article")) type = "document";
    }
    collectFromObj(mo);
  }

  if (Array.isArray(item.images)) {
    type = type === "none" ? "image" : type;
    for (const im of item.images as unknown[]) {
      if (typeof im === "string") urls.push(im);
      else if (im && typeof im === "object" && typeof (im as Record<string, unknown>).url === "string") urls.push((im as Record<string, unknown>).url as string);
    }
  }

  // harvestapi: postImages: [{ url, width, height }]. Multiple entries =
  // an image carousel — we collect them all (the UI shows the first).
  if (Array.isArray(item.postImages)) {
    for (const im of item.postImages as unknown[]) {
      if (im && typeof im === "object" && typeof (im as Record<string, unknown>).url === "string") {
        urls.push((im as Record<string, unknown>).url as string);
      }
    }
    if (urls.length > 0 && type === "none") type = "image";
  }

  // harvestapi: postVideo: { thumbnailUrl, videoUrl }. The swipe file is
  // preview-only (no playback) and the UI renders media_urls[0] as an
  // <img>. Only the THUMBNAIL is image-renderable — the videoUrl is a
  // dms.licdn playlist (not an image), so we must NOT let it become
  // media_urls[0] or next/image errors on it.
  //
  // Guards:
  // - Require a valid http thumbnail before treating this as video. If a
  //   post has only a videoUrl and no usable thumbnail, we skip it
  //   (leave type/urls as whatever images already set, or "none").
  // - Don't clobber an existing image/document type: a post with both
  //   images and a video stays "image" (its postImages render fine).
  //   Only a video-WITHOUT-other-media post becomes "video".
  if (item.postVideo && typeof item.postVideo === "object") {
    const pv = item.postVideo as Record<string, unknown>;
    const thumb =
      typeof pv.thumbnailUrl === "string" && pv.thumbnailUrl.startsWith("http")
        ? pv.thumbnailUrl
        : null;
    if (thumb && type === "none" && urls.length === 0) {
      urls.push(thumb);
      type = "video";
    }
  }

  // harvestapi PDF document carousels:
  //   document: { coverPages: [{ imageUrls: [...rendered page images] }] }
  // LinkedIn pre-renders the pages as images — exactly what our image-based
  // card previews want. Collect every page image. Only flip to "document"
  // if nothing else already claimed the media (a doc post has no images/
  // video), so we never clobber an image/video type.
  if (item.document && typeof item.document === "object" && type === "none" && urls.length === 0) {
    const doc = item.document as Record<string, unknown>;
    if (Array.isArray(doc.coverPages)) {
      for (const page of doc.coverPages as unknown[]) {
        if (page && typeof page === "object") {
          const imgs = (page as Record<string, unknown>).imageUrls;
          if (Array.isArray(imgs)) {
            for (const u of imgs) if (typeof u === "string") urls.push(u);
          }
        }
      }
    }
    if (urls.length > 0) type = "document";
  }

  return { media_type: type, media_urls: Array.from(new Set(urls.filter((u) => u.startsWith("http")))) };
}

function pickPostId(item: Record<string, unknown>): string | null {
  // harvestapi: shareUrn is the canonical "urn:li:share:<id>" form — and it's
  // exactly what the embed-probe logic prefers (migration 017/018). Use it as
  // the dedup key (linkedin_post_id). NOTE: this id differs from the activity
  // urn apimaestro stored, so switching actors causes a one-time re-insert of
  // historical posts. Acceptable; documented in the swap PR.
  if (typeof item.shareUrn === "string") return item.shareUrn;

  // apimaestro shapes
  if (typeof item.full_urn === "string") return item.full_urn;
  const urn = item.urn;
  if (urn && typeof urn === "object") {
    const u = urn as Record<string, unknown>;
    if (typeof u.activity_urn === "string") return `urn:li:activity:${u.activity_urn}`;
    if (typeof u.ugcPost_urn === "string") return `urn:li:ugcPost:${u.ugcPost_urn}`;
    if (typeof u.share_urn === "string") return `urn:li:share:${u.share_urn}`;
  }
  // harvestapi fallback: bare numeric id (rare — shareUrn almost always present)
  if (typeof item.id === "string") return `urn:li:activity:${item.id}`;
  if (typeof item.url === "string") return item.url as string;
  if (typeof item.linkedinUrl === "string") return item.linkedinUrl as string;
  return null;
}

function pickPostedAt(item: Record<string, unknown>): string | null {
  // Both actors expose a posted-at object — apimaestro as posted_at,
  // harvestapi as postedAt — each with { timestamp, date }. harvestapi's
  // date is already a clean ISO string; apimaestro's needs the space→T fix.
  const p = item.posted_at ?? item.postedAt;
  if (p && typeof p === "object") {
    const po = p as Record<string, unknown>;
    if (typeof po.timestamp === "number") return new Date(po.timestamp).toISOString();
    if (typeof po.date === "string") {
      const raw = po.date as string;
      // ISO already (harvestapi): Date parses directly. apimaestro uses
      // "YYYY-MM-DD HH:MM:SS" with no zone → normalize to UTC.
      const d = raw.includes("T") ? new Date(raw) : new Date(raw.replace(" ", "T") + "Z");
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  if (typeof item.postedAt === "string") return item.postedAt as string;
  return null;
}

function pickHandle(item: Record<string, unknown>): string | null {
  if (typeof item.__username === "string") return (item.__username as string).toLowerCase();
  const a = item.author;
  if (a && typeof a === "object") {
    const au = a as Record<string, unknown>;
    // harvestapi: publicIdentifier. apimaestro: username.
    if (typeof au.publicIdentifier === "string") return (au.publicIdentifier as string).toLowerCase();
    if (typeof au.username === "string") return (au.username as string).toLowerCase();
    // Both may carry a profile URL — apimaestro profile_url, harvestapi linkedinUrl.
    const profileUrl =
      typeof au.profile_url === "string"
        ? (au.profile_url as string)
        : typeof au.linkedinUrl === "string"
          ? (au.linkedinUrl as string)
          : null;
    if (profileUrl) {
      const m = profileUrl.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
      if (m) return m[1].toLowerCase();
    }
  }
  return null;
}

function pickAuthorMeta(item: Record<string, unknown>): { pic: string | null; headline: string | null } {
  const a = item.author;
  if (!a || typeof a !== "object") return { pic: null, headline: null };
  const au = a as Record<string, unknown>;

  // pic: apimaestro author.profile_picture (string); harvestapi author.avatar.url
  let pic: string | null = null;
  if (typeof au.profile_picture === "string" && au.profile_picture.startsWith("http")) {
    pic = au.profile_picture;
  } else if (au.avatar && typeof au.avatar === "object") {
    const av = au.avatar as Record<string, unknown>;
    if (typeof av.url === "string" && av.url.startsWith("http")) pic = av.url;
  }

  // headline: apimaestro author.headline; harvestapi author.info
  const rawHeadline =
    typeof au.headline === "string"
      ? au.headline
      : typeof au.info === "string"
        ? au.info
        : null;
  const headline = rawHeadline && rawHeadline.trim().length > 0 ? rawHeadline.trim() : null;

  return { pic, headline };
}

export function normalizePost(item: Record<string, unknown>): ScrapedPost | null {
  const id = pickPostId(item);
  if (!id) return null;

  // Engagement: apimaestro nests in `stats`; harvestapi nests in `engagement`
  // as { likes, comments, shares } (NOTE harvestapi also has a top-level
  // `reactions` ARRAY of {type,count} — never read that as a number).
  const stats = (item.stats && typeof item.stats === "object" ? item.stats : {}) as Record<string, unknown>;
  const eng = (item.engagement && typeof item.engagement === "object" ? item.engagement : {}) as Record<string, unknown>;
  const reactions = toInt(
    stats.total_reactions ?? eng.likes ?? item.numLikes ?? item.likes,
  );
  const comments = toInt(stats.comments ?? eng.comments ?? item.numComments);
  const reposts = toInt(stats.reposts ?? eng.shares ?? item.numShares ?? item.shares);
  const { media_type, media_urls } = pickMedia(item);

  // For PDF document carousels, capture the manifest URL + page count so
  // the full deck can be resolved on demand (cover pages in media_urls are
  // the fallback). Only present on harvestapi document posts.
  let documentManifestUrl: string | null = null;
  let documentPageCount: number | null = null;
  if (media_type === "document" && item.document && typeof item.document === "object") {
    const doc = item.document as Record<string, unknown>;
    if (typeof doc.manifestUrl === "string") documentManifestUrl = doc.manifestUrl;
    if (typeof doc.totalPageCount === "number") documentPageCount = doc.totalPageCount;
  }

  const { pic, headline } = pickAuthorMeta(item);
  return {
    linkedin_post_id: id,
    // apimaestro: url. harvestapi: linkedinUrl (pretty /posts/ form) and
    // shareLinkedinUrl (feed URL).
    //
    // Prefer the pretty linkedinUrl: its tail carries the ACTIVITY id,
    // which both our URL parser (SLUG_TAIL_RE) and the embed-probe
    // (share/activity candidates) resolve reliably. shareLinkedinUrl is
    // NOT reliable — harvestapi returns it as urn:li:ugcPost:<id> for many
    // posts, and (a) that id differs from the activity id, (b) the probe
    // doesn't try ugcPost, (c) bookmarking it threw "Couldn't read that
    // URL". Fall back to shareLinkedinUrl only if the pretty URL is absent.
    post_url:
      (item.url as string) ||
      (item.linkedinUrl as string) ||
      (item.shareLinkedinUrl as string) ||
      null,
    posted_at: pickPostedAt(item),
    text: (item.text as string) || (item.content as string) || null,
    reactions,
    comments,
    reposts,
    media_type,
    media_urls,
    document_manifest_url: documentManifestUrl,
    document_page_count: documentPageCount,
    author_handle: pickHandle(item),
    author_profile_pic_url: pic,
    author_headline: headline,
  };
}
