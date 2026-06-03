import { scopedSupabase, trackedAccountIds } from "./supabase-scoped";
import { median } from "./viral";

// Aggregate insight queries for the Insights page. Every one of these is pure
// SQL-fetch + in-JS reduction over the workspace's tracked posts — no AI, no
// new data. They all scope by the same tracked-account id set so the numbers
// match what the user sees in the swipe file.

// PostgREST has no GROUP BY / per-group aggregate, so we fetch the narrow
// columns we need (capped) and reduce in JS. The cap is generous; a workspace
// would need tens of thousands of viral posts to approach it.
const FETCH_CAP = 20000;
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

async function scopedIds(): Promise<{ sb: Awaited<ReturnType<typeof scopedSupabase>>; idFilter: string[] }> {
  const sb = await scopedSupabase();
  const accountIds = await trackedAccountIds(sb.workspaceId);
  // A non-empty sentinel keeps the `.in()` valid (and matching nothing) when
  // the workspace tracks no accounts, instead of returning everyone's data.
  return { sb, idFilter: accountIds.length ? accountIds : [MISSING_ID] };
}

export type PostTypeRow = {
  postType: string; // "regular" | "lead_magnet" | other
  posts: number;
  viralPosts: number;
  hitRate: number;
  medianViralScore: number;
};

/**
 * B2 — Post-type performance board. Groups the workspace's tracked posts by
 * post_type (regular vs lead_magnet) and reports volume, viral hit-rate, and
 * median engagement. Answers "do lead-magnet posts actually out-perform
 * regular ones for the creators I track, or just feel like they should."
 */
export async function fetchPostTypeBoard(): Promise<PostTypeRow[]> {
  const { sb, idFilter } = await scopedIds();
  const { data, error } = await sb.raw
    .from("posts")
    .select("post_type, viral_score, is_viral")
    .in("account_id", idFilter)
    .limit(FETCH_CAP);
  if (error) throw new Error(`Failed to load post-type board: ${error.message}`);

  const buckets = new Map<string, { scores: number[]; viral: number }>();
  for (const p of data ?? []) {
    const type = (p.post_type as string | null) ?? "regular";
    const b = buckets.get(type) ?? { scores: [], viral: 0 };
    b.scores.push(Number(p.viral_score ?? 0));
    if (p.is_viral) b.viral += 1;
    buckets.set(type, b);
  }

  const rows: PostTypeRow[] = [...buckets.entries()].map(([postType, b]) => ({
    postType,
    posts: b.scores.length,
    viralPosts: b.viral,
    hitRate: b.scores.length ? b.viral / b.scores.length : 0,
    medianViralScore: median(b.scores) ?? 0,
  }));

  // Most-used type first — the board reads as "here's your mix, and how each
  // slice performs."
  rows.sort((a, b) => b.posts - a.posts);
  return rows;
}

// Day-of-week × hour grid of posting performance. posted_at is stored in UTC;
// posting-time advice only makes sense in a human timezone, so we bucket by a
// fixed reference zone (US Eastern — where most of the tracked B2B/agency
// audience sits) and label it as such. Hours are 0-23, days 0=Sun..6=Sat.
export const HEATMAP_TZ = "America/New_York";
export const HEATMAP_TZ_LABEL = "ET";

export type TimeHeatmapCell = {
  day: number; // 0=Sun .. 6=Sat
  hour: number; // 0..23
  posts: number;
  viralPosts: number;
  medianViralScore: number;
};

export type TimeHeatmap = {
  cells: TimeHeatmapCell[]; // only non-empty buckets
  maxMedian: number; // median viral score across slots (kept for the tooltip)
  maxViral: number; // busiest-slot viral-post count — drives cell colour
  totalPosts: number;
};

// Reusable formatter: extract the ET weekday + hour from a UTC instant without
// pulling in a date lib. `weekday: "short"` → map to 0..6; `hour: "numeric"`
// in 24h → parse int.
const HEATMAP_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: HEATMAP_TZ,
  weekday: "short",
  hour: "numeric",
  hour12: false,
});
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function etDayHour(iso: string): { day: number; hour: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = HEATMAP_FMT.formatToParts(d);
  const wd = parts.find((p) => p.type === "weekday")?.value;
  const hr = parts.find((p) => p.type === "hour")?.value;
  if (!wd || hr == null) return null;
  const day = WEEKDAY_INDEX[wd];
  // Intl can emit "24" for midnight in some runtimes — normalise to 0.
  const hour = parseInt(hr, 10) % 24;
  if (Number.isNaN(hour)) return null;
  if (Number.isNaN(day)) return null;
  return { day, hour };
}

/**
 * B3 — Best-time-to-post heatmap. Buckets tracked posts by (ET weekday, hour)
 * and reports the median viral score per slot, so the user can see when the
 * creators they track tend to land their biggest posts.
 */
export async function fetchTimeHeatmap(): Promise<TimeHeatmap> {
  const { sb, idFilter } = await scopedIds();
  const { data, error } = await sb.raw
    .from("posts")
    .select("posted_at, viral_score, is_viral")
    .in("account_id", idFilter)
    .not("posted_at", "is", null)
    .limit(FETCH_CAP);
  if (error) throw new Error(`Failed to load time heatmap: ${error.message}`);

  const buckets = new Map<string, { scores: number[]; viral: number }>();
  let totalPosts = 0;
  for (const p of data ?? []) {
    const at = p.posted_at as string | null;
    if (!at) continue;
    const dh = etDayHour(at);
    if (!dh) continue;
    totalPosts += 1;
    const key = `${dh.day}:${dh.hour}`;
    const b = buckets.get(key) ?? { scores: [], viral: 0 };
    b.scores.push(Number(p.viral_score ?? 0));
    if (p.is_viral) b.viral += 1;
    buckets.set(key, b);
  }

  const cells: TimeHeatmapCell[] = [...buckets.entries()].map(([key, b]) => {
    const [day, hour] = key.split(":").map((n) => parseInt(n, 10));
    return {
      day,
      hour,
      posts: b.scores.length,
      viralPosts: b.viral,
      medianViralScore: median(b.scores) ?? 0,
    };
  });
  const maxMedian = cells.reduce((m, c) => Math.max(m, c.medianViralScore), 0);
  // Cell colour scales by how MANY viral posts landed in a slot — answering
  // "when do big posts land" by frequency, not by how strong any single post
  // was. (Median score is misleading here: one great post in an off-hour slot
  // would out-darken a slot that reliably produces several viral posts.)
  const maxViral = cells.reduce((m, c) => Math.max(m, c.viralPosts), 0);
  return { cells, maxMedian, maxViral, totalPosts };
}

export type NicheRow = {
  niche: string;
  creators: number; // distinct tracked creators in this niche
  posts: number;
  viralPosts: number;
  hitRate: number;
  medianViralScore: number;
};

/**
 * B4 — Niche scoreboard. Groups tracked posts by their creator's niche and
 * reports creator count, volume, viral hit-rate, and median engagement —
 * a "which spaces are hot" overview across everything the workspace tracks.
 */
export async function fetchNicheScoreboard(): Promise<NicheRow[]> {
  const { sb, idFilter } = await scopedIds();
  const { data, error } = await sb.raw
    .from("posts")
    .select("viral_score, is_viral, account_id, accounts!inner(niche)")
    .in("account_id", idFilter)
    .limit(FETCH_CAP);
  if (error) throw new Error(`Failed to load niche scoreboard: ${error.message}`);

  const buckets = new Map<
    string,
    { scores: number[]; viral: number; creators: Set<string> }
  >();
  for (const p of data ?? []) {
    const acc = Array.isArray(p.accounts) ? p.accounts[0] ?? null : p.accounts;
    const niche = ((acc as { niche?: string | null } | null)?.niche ?? "").trim() || "Uncategorized";
    const b = buckets.get(niche) ?? { scores: [], viral: 0, creators: new Set<string>() };
    b.scores.push(Number(p.viral_score ?? 0));
    if (p.is_viral) b.viral += 1;
    b.creators.add(p.account_id as string);
    buckets.set(niche, b);
  }

  const rows: NicheRow[] = [...buckets.entries()].map(([niche, b]) => ({
    niche,
    creators: b.creators.size,
    posts: b.scores.length,
    viralPosts: b.viral,
    hitRate: b.scores.length ? b.viral / b.scores.length : 0,
    medianViralScore: median(b.scores) ?? 0,
  }));

  // Highest median engagement first — the scoreboard answers "which niches
  // produce the strongest posts among the creators I track."
  rows.sort((a, b) => b.medianViralScore - a.medianViralScore || b.posts - a.posts);
  return rows;
}
