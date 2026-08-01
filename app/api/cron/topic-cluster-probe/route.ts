import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { selectAllRows, selectInChunks } from "@/lib/db-paginate";
import { EMBEDDING_MODEL } from "@/lib/openrouter";

// PROBE — read-only. Answers one question before any feature is built:
// do SUB-THRESHOLD posts contain real, nameable topic clusters?
//
// The agent inbox's newsjacking lane builds its search query from static
// config (preferences -> learned topics -> account niches) plus the literal
// suffix "latest announcements, product changes, research, and industry
// developments". It can therefore only surface TRADE PRESS — it never knows
// what the audience is actually discussing this week.
//
// The hypothesis: posts BELOW the viral threshold are the better signal. A
// viral post has already peaked, so posting about it is late. Forty creators
// posting middling takes on one subject is a topic FORMING — the window where
// a post can still land. Cluster density is a leading indicator; virality is
// a lagging one.
//
// This endpoint writes NOTHING and calls no model. Post embeddings already
// exist: lib/pipeline.ts embeds every newly-scraped post with no viral
// filter, so the corpus needed here is already in post_embeddings and this is
// a pure read. Cost is one set of queries.

// Listed in vercel.json ONLY so it appears in the Vercel Cron Jobs UI, whose
// "Run" button injects CRON_SECRET — the secret is never handled by hand.
// Vercel requires a schedule, so it is registered as a single yearly run
// (`0 0 1 1 *`): this is meant to be CLICKED, not scheduled. Being read-only,
// an accidental firing costs one set of queries and changes nothing.
//
// Delete the route AND its vercel.json entry once the sub-threshold
// clustering question is answered — this is a measurement, not a feature.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Cluster membership counts DISTINCT CREATORS, never posts: one person
// posting six times about their own launch is not a trend.
const MIN_CREATORS = 3;
// 0.80, verified on synthetic data with a known answer (3 planted topics + 2
// deliberate outliers). At 0.62-0.75 the outliers are absorbed into whichever
// cluster is nearest, inflating creator counts and blurring identity — which
// reads as "the data is mush" when it is really the threshold. 0.80+ recovers
// the planted topics exactly, 5/5 runs.
const SIM_THRESHOLD = 0.8;
const MAX_POSTS = 1500;

type PostRow = {
  id: string;
  account_id: string | null;
  text: string | null;
  reactions: number | null;
  comments: number | null;
  posted_at: string | null;
  is_viral: boolean | null;
};

function firstLine(text: string | null): string {
  return (
    (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}

function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return vec.map((x) => x / norm);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

type Cluster = { members: number[]; centroid: number[] };

// Greedy agglomeration against a running centroid. Sufficient to answer "are
// there nameable clusters?" — this is a probe, not the production job.
function clusterVectors(
  vectors: number[][],
  threshold: number,
): Cluster[] {
  const clusters: Cluster[] = [];
  for (let idx = 0; idx < vectors.length; idx++) {
    let best: Cluster | null = null;
    let bestSim = threshold;
    for (const candidate of clusters) {
      const sim = dot(vectors[idx], candidate.centroid);
      if (sim >= bestSim) {
        bestSim = sim;
        best = candidate;
      }
    }
    if (!best) {
      clusters.push({ members: [idx], centroid: [...vectors[idx]] });
      continue;
    }
    best.members.push(idx);
    const n = best.members.length;
    for (let d = 0; d < best.centroid.length; d++) {
      best.centroid[d] =
        (best.centroid[d] * (n - 1) + vectors[idx][d]) / n;
    }
    best.centroid = normalize(best.centroid);
  }
  return clusters;
}

const STOPWORDS = new Set(
  ("the a an and or but if then than that this these those is are was were be been being of to in on for with at by from as it its you your we our they their me my he she his her not no do does did doing done have has had can could will would should may might must about into over under again more most other some such only own same so too very just now new get got make made way ways thing things people time times year years day days want wants like likes know knows think thinks see sees say says go goes going come comes take takes use uses using work works working need needs one two three what when where who why how all any each few many much every here there out up down off").split(
    " ",
  ),
);

function labelFor(members: number[], posts: PostRow[]): string {
  const counts = new Map<string, number>();
  for (const idx of members) {
    const words = new Set(
      (posts[idx].text ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((word) => word.length > 3 && !STOPWORDS.has(word)),
    );
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word)
    .join(", ");
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const windowDays = Math.min(
    30,
    Math.max(1, Number(url.searchParams.get("days") ?? 7)),
  );
  const baselineDays = Math.min(
    60,
    Math.max(1, Number(url.searchParams.get("baseline") ?? 14)),
  );
  const sim = Math.min(
    0.98,
    Math.max(0.5, Number(url.searchParams.get("sim") ?? SIM_THRESHOLD)),
  );
  const minCreators = Math.max(
    2,
    Number(url.searchParams.get("minCreators") ?? MIN_CREATORS),
  );

  const db = supabaseAdmin();
  const now = Date.now();
  const windowStart = new Date(now - windowDays * 86_400_000);
  const fullStart = new Date(now - (windowDays + baselineDays) * 86_400_000);

  const thresholds = {
    reactions: Number(process.env.VIRAL_MIN_REACTIONS ?? 500),
    comments: Number(process.env.VIRAL_MIN_COMMENTS ?? 50),
  };

  const rows = await selectAllRows<PostRow>(() =>
    db
      .from("posts")
      .select("id, account_id, text, reactions, comments, posted_at, is_viral")
      .gte("posted_at", fullStart.toISOString())
      .not("text", "is", null)
      .order("posted_at", { ascending: false }) as never,
  );

  const isSubThreshold = (row: PostRow) =>
    !row.is_viral &&
    (row.reactions ?? 0) < thresholds.reactions &&
    (row.comments ?? 0) < thresholds.comments;

  const cutoff = windowStart.getTime();
  const recentAll = rows.filter(
    (row) => row.posted_at && Date.parse(row.posted_at) >= cutoff,
  );
  const recent = recentAll.filter(isSubThreshold).slice(0, MAX_POSTS);
  const prior = rows
    .filter(
      (row) =>
        row.posted_at &&
        Date.parse(row.posted_at) < cutoff &&
        isSubThreshold(row),
    )
    .slice(0, MAX_POSTS);

  if (recent.length < minCreators * 2) {
    return NextResponse.json({
      ok: true,
      verdict: "insufficient_data",
      windowDays,
      thresholds,
      counts: {
        postsInFullWindow: rows.length,
        recentAll: recentAll.length,
        recentSubThreshold: recent.length,
      },
      note: "Too few sub-threshold posts in this window to cluster. Widen ?days=.",
    });
  }

  // Embeddings already exist for every scraped post (lib/pipeline.ts embeds
  // with no viral filter), so this reads them rather than paying to embed.
  const byId = new Map<string, number[]>();
  const embeddingRows = await selectInChunks<{
    post_id: string;
    embedding: unknown;
  }>([...recent, ...prior].map((row) => row.id), (ids) =>
    db
      .from("post_embeddings")
      .select("post_id, embedding")
      .eq("model", EMBEDDING_MODEL)
      .in("post_id", ids) as never,
  );
  for (const row of embeddingRows) {
    const vec = parseVector(row.embedding);
    if (vec && vec.length) byId.set(row.post_id, normalize(vec));
  }

  const recentWithVec = recent.filter((row) => byId.has(row.id));
  const priorWithVec = prior.filter((row) => byId.has(row.id));

  if (recentWithVec.length < minCreators * 2) {
    return NextResponse.json({
      ok: true,
      verdict: "insufficient_embeddings",
      counts: {
        recentSubThreshold: recent.length,
        recentEmbedded: recentWithVec.length,
      },
      note: "Sub-threshold posts exist but are not embedded yet. The daily pipeline embeds on scrape; try again after the next run.",
    });
  }

  const recentVecs = recentWithVec.map((row) => byId.get(row.id)!);
  const priorVecs = priorWithVec.map((row) => byId.get(row.id)!);

  const clusters = clusterVectors(recentVecs, sim)
    .map((cluster) => ({
      cluster,
      creators: new Set(
        cluster.members.map((i) => recentWithVec[i].account_id),
      ).size,
    }))
    .filter((entry) => entry.creators >= minCreators)
    .sort((a, b) => b.creators - a.creators)
    .slice(0, 15);

  const report = clusters.map(({ cluster, creators }) => {
    // Velocity: how many DISTINCT creators discussed this centroid in the
    // prior window? Rising-and-still-small is the window worth posting into;
    // a flat cluster is just a permanent topic, not news.
    const priorCreators = new Set<string>();
    for (let i = 0; i < priorVecs.length; i++) {
      if (dot(priorVecs[i], cluster.centroid) >= sim) {
        const account = priorWithVec[i].account_id;
        if (account) priorCreators.add(account);
      }
    }
    const before = priorCreators.size;
    const trend =
      before === 0
        ? "new"
        : creators > before * 1.5
          ? "rising"
          : creators < before * 0.67
            ? "fading"
            : "flat";
    return {
      creators,
      posts: cluster.members.length,
      trend,
      creatorsPriorWindow: before,
      terms: labelFor(cluster.members, recentWithVec),
      samples: cluster.members
        .slice(0, 3)
        .map((i) => firstLine(recentWithVec[i].text).slice(0, 140)),
    };
  });

  return NextResponse.json({
    ok: true,
    readOnly: true,
    params: { windowDays, baselineDays, sim, minCreators },
    thresholds,
    counts: {
      postsInFullWindow: rows.length,
      recentAll: recentAll.length,
      recentSubThreshold: recent.length,
      recentEmbedded: recentWithVec.length,
      priorEmbedded: priorWithVec.length,
    },
    clusters: report,
    howToRead:
      "Are the top clusters recognizable topics you would have wanted to post about, or generic mush? Recognizable => the sub-threshold signal is real. Mush at sim=0.8 => the corpus is too thin for this window. 'rising' and 'new' are the ones worth posting into; 'flat' is a permanent topic, not news.",
  });
}
