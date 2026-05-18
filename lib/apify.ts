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
  author_handle: string | null;
  author_profile_pic_url: string | null;
  author_headline: string | null;
};

const ACTOR = process.env.APIFY_ACTOR_ID || "apimaestro~linkedin-profile-posts";

function token(): string {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) throw new Error("APIFY_API_TOKEN not set");
  return t;
}

import { logApifyUsage } from "./usage";

export async function runOneProfile(username: string): Promise<unknown[]> {
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, limit: 1, page_number: 1 }),
  });
  if (!res.ok) {
    // Failed call — log a zero-cost attempt so it shows up in the audit trail
    logApifyUsage("profile_posts_fail", 0, { username, status: res.status });
    throw new Error(`Apify ${res.status} for ${username}`);
  }
  const items = (await res.json()) as unknown[];
  const arr = Array.isArray(items) ? items : [];
  const filtered = arr.filter((it) => {
    if (!it || typeof it !== "object") return false;
    const o = it as Record<string, unknown>;
    if (typeof o.message === "string" && !o.urn && !o.full_urn) return false;
    return true;
  });
  // apimaestro/linkedin-profile-posts is pay-per-result at $5/1000 posts.
  // Count every billable result returned (filtered count). Failed lookups
  // ("No profile found") get filtered out above and aren't billed.
  logApifyUsage("profile_posts", filtered.length, {
    username, items: filtered.length, raw_items: arr.length,
  });
  filtered.forEach((it) => { (it as Record<string, unknown>).__username = username; });
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
  const results = await pool(usernames, 8, async (u) => {
    const items = await runOne(u);
    return items.map((it) => {
      if (it && typeof it === "object") (it as Record<string, unknown>).__username = u;
      return it;
    });
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

  return { media_type: type, media_urls: Array.from(new Set(urls.filter((u) => u.startsWith("http")))) };
}

function pickPostId(item: Record<string, unknown>): string | null {
  if (typeof item.full_urn === "string") return item.full_urn;
  const urn = item.urn;
  if (urn && typeof urn === "object") {
    const u = urn as Record<string, unknown>;
    if (typeof u.activity_urn === "string") return `urn:li:activity:${u.activity_urn}`;
    if (typeof u.ugcPost_urn === "string") return `urn:li:ugcPost:${u.ugcPost_urn}`;
    if (typeof u.share_urn === "string") return `urn:li:share:${u.share_urn}`;
  }
  if (typeof item.url === "string") return item.url as string;
  return null;
}

function pickPostedAt(item: Record<string, unknown>): string | null {
  const p = item.posted_at;
  if (p && typeof p === "object") {
    const po = p as Record<string, unknown>;
    if (typeof po.timestamp === "number") return new Date(po.timestamp).toISOString();
    if (typeof po.date === "string") {
      const d = new Date((po.date as string).replace(" ", "T") + "Z");
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
    if (typeof au.username === "string") return (au.username as string).toLowerCase();
    if (typeof au.profile_url === "string") {
      const m = (au.profile_url as string).match(/linkedin\.com\/in\/([^\/\?#]+)/i);
      if (m) return m[1].toLowerCase();
    }
  }
  return null;
}

function pickAuthorMeta(item: Record<string, unknown>): { pic: string | null; headline: string | null } {
  const a = item.author;
  if (!a || typeof a !== "object") return { pic: null, headline: null };
  const au = a as Record<string, unknown>;
  const pic = typeof au.profile_picture === "string" && au.profile_picture.startsWith("http")
    ? (au.profile_picture as string)
    : null;
  const headline = typeof au.headline === "string" && au.headline.trim().length > 0
    ? (au.headline as string).trim()
    : null;
  return { pic, headline };
}

export function normalizePost(item: Record<string, unknown>): ScrapedPost | null {
  const id = pickPostId(item);
  if (!id) return null;

  const stats = (item.stats && typeof item.stats === "object" ? item.stats : {}) as Record<string, unknown>;
  const reactions = toInt(stats.total_reactions ?? item.numLikes ?? item.likes ?? item.reactions);
  const comments = toInt(stats.comments ?? item.numComments ?? item.comments);
  const reposts = toInt(stats.reposts ?? item.numShares ?? item.shares ?? item.reposts);
  const { media_type, media_urls } = pickMedia(item);

  const { pic, headline } = pickAuthorMeta(item);
  return {
    linkedin_post_id: id,
    post_url: (item.url as string) || null,
    posted_at: pickPostedAt(item),
    text: (item.text as string) || (item.content as string) || null,
    reactions,
    comments,
    reposts,
    media_type,
    media_urls,
    author_handle: pickHandle(item),
    author_profile_pic_url: pic,
    author_headline: headline,
  };
}
