import { supabaseAdmin } from "./supabase";

export type LandingStats = {
  creatorsTracked: number;
  postsPulledToday: number;
  viralPostsArchived: number;
  templatesGenerated: number;
};

// Fallbacks rendered if the stats query fails — we never want the marketing
// page to crash because the DB blipped. These match the placeholder values
// the page used before this became live data; honest enough as a degraded
// floor while we recover.
const FALLBACK: LandingStats = {
  creatorsTracked: 100,
  postsPulledToday: 0,
  viralPostsArchived: 0,
  templatesGenerated: 0,
};

/**
 * Live counts for the landing page's "Numbers" strip. Reads directly off
 * the public catalog with no workspace scoping — these are global
 * marketing numbers, not per-tenant.
 *
 * All four counts run in parallel with PostgREST's count-only mode
 * (`{ count: "exact", head: true }`), so we pay one network round-trip
 * per stat and zero row transfer. Each query independently degrades to its
 * fallback on failure (a single flaky query won't blank out the other
 * three).
 *
 * Counts are tagged `force-cache` + 5-minute revalidate on the caller (see
 * marketing page.tsx) — these don't need second-by-second freshness, and
 * caching keeps the marketing route fast on a cold visit.
 */
export async function getLandingStats(): Promise<LandingStats> {
  const sb = supabaseAdmin();
  // Start-of-day in UTC for "posts pulled today" — matches the cron schedule
  // ("Every morning at 06:00 UTC" per the bento copy), so the number resets
  // on the same boundary the user is reading about above the fold.
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startOfDayIso = startOfDay.toISOString();

  const [creators, today, viral, templates] = await Promise.all([
    // Distinct creators in the public catalog (exclude soft-archived rows).
    sb
      .from("accounts")
      .select("id", { count: "exact", head: true })
      .is("archived_at", null),
    sb
      .from("posts")
      .select("id", { count: "exact", head: true })
      .gte("scraped_at", startOfDayIso),
    sb
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("is_viral", true),
    sb.from("templates").select("id", { count: "exact", head: true }),
  ]);

  return {
    creatorsTracked: creators.count ?? FALLBACK.creatorsTracked,
    postsPulledToday: today.count ?? FALLBACK.postsPulledToday,
    viralPostsArchived: viral.count ?? FALLBACK.viralPostsArchived,
    templatesGenerated: templates.count ?? FALLBACK.templatesGenerated,
  };
}

export type LandingTopCreator = {
  id: string;
  name: string;
  niche: string | null;
  imageUrl: string;
  viralPostCount: number;
};

/**
 * Real creators powering the swipe file, ranked by how many of their posts
 * have been flagged as viral. Names, niches, and profile pictures come from
 * the public LinkedIn profiles we already track; the fallback avatar is a
 * deterministic Notion-style SVG from DiceBear (CC0) when a picture is missing.
 */
export async function getTopCreatorsForLanding(limit = 8): Promise<LandingTopCreator[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("posts")
    .select("account_id, accounts!inner(id, name, niche, profile_pic_url)")
    .eq("is_viral", true)
    .not("account_id", "is", null);

  if (error || !data) {
    return [];
  }

  const map = new Map<string, LandingTopCreator>();
  for (const row of data) {
    const acc = (row as unknown as { accounts: { id: string; name: string; niche: string | null; profile_pic_url: string | null } }).accounts;
    if (!acc?.name) continue;
    const existing = map.get(acc.id);
    if (existing) {
      existing.viralPostCount++;
    } else {
      map.set(acc.id, {
        id: acc.id,
        name: acc.name,
        niche: acc.niche,
        imageUrl:
          acc.profile_pic_url ??
          `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(acc.name)}`,
        viralPostCount: 1,
      });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.viralPostCount - a.viralPostCount)
    .slice(0, limit);
}

// Compact a count for display: 12345 → "12k", 4_200_000 → "4.2M".
// Below 1k stays as exact integer with a thousands separator (e.g. "847"
// reads as a real, growing number — rounding small counts to "1k" looks
// like marketing fluff).
export function formatStatCount(n: number): string {
  if (n < 1_000) return new Intl.NumberFormat("en-US").format(n);
  if (n < 1_000_000) {
    const k = n / 1_000;
    // Two sig figs under 10k (e.g. "1.2k"), whole-k above ("47k").
    return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}
