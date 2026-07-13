import { supabaseAdmin } from "@/lib/supabase";
import { retrieveExemplars } from "@/lib/post-embeddings";
import type { PostType } from "@/lib/post-type";

// Retrieval-augmented drafting (the viral-learning loop, PR 3). For a draft
// being written from a source post, pull the semantically-nearest VIRAL posts
// (positive exemplars — extra structural angles beyond the one source) and
// MEDIOCRE posts on the same theme (negatives — patterns that underperformed
// HERE, to avoid). Both come from the embedded corpus (migration-088) via
// cosine similarity.
//
// Guardrails baked in:
//   - Relative-virality framing is inherited from the corpus: `is_viral` is
//     judged vs each creator's OWN baseline, so exemplars aren't just
//     big-account posts.
//   - Diversity: we over-fetch and down-sample so the block isn't three
//     near-duplicates of the same winning post (homogenization guard).
//   - Never surfaces AI-written drafts: the corpus is scraped `posts` only.

// How many to actually show the writer, and how many to over-fetch for the
// diversity down-sample.
const VIRAL_SHOW = 2;
const MEDIOCRE_SHOW = 2;
const OVERFETCH = 8;
// Trim each exemplar so a few of them can't blow the prompt budget.
const EXEMPLAR_CHARS = 600;

export type ExemplarBlock = {
  block: string;
  viralCount: number;
  mediocreCount: number;
};

// A cheap lexical fingerprint for the diversity down-sample: the first ~6
// meaningful tokens. Two posts opening the same way (same hook, minor tail
// variation) are treated as redundant so we don't show three variations of the
// same winning post.
function fingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
}

// Down-sample matches to `keep`, skipping ones whose opening fingerprint we've
// already taken (keeps structural variety). Matches arrive nearest-first, so we
// keep the closest of each distinct opener.
function diversify<T extends { text: string }>(rows: T[], keep: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const fp = fingerprint(row.text);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(row);
    if (out.length >= keep) break;
  }
  return out;
}

// Fetch the bodies for a set of post ids, preserving the input order (which is
// similarity order from the RPC).
async function fetchBodies(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin()
    .from("posts")
    .select("id, text")
    .in("id", ids);
  if (error) throw error;
  const byId = new Map<string, string>();
  for (const row of data ?? []) {
    if (typeof row.text === "string" && row.text.trim()) {
      byId.set(row.id as string, row.text);
    }
  }
  return byId;
}

// Build the exemplar block for a draft. Returns block:"" (and zero counts) when
// nothing useful is retrieved, so the caller can append unconditionally.
// Best-effort by contract: the caller wraps this in try/catch and drafts
// without exemplars if retrieval fails — the loop must never break the batch.
export async function buildExemplarBlock(opts: {
  topicText: string;
  postType?: PostType | null;
  excludeIds?: string[];
  workspaceId?: string;
  signal?: AbortSignal;
}): Promise<ExemplarBlock> {
  const topic = opts.topicText.trim();
  if (!topic) return { block: "", viralCount: 0, mediocreCount: 0 };

  const [viralMatches, mediocreMatches] = await Promise.all([
    retrieveExemplars({
      queryText: topic,
      wantViral: true,
      postType: opts.postType ?? null,
      excludeIds: opts.excludeIds,
      matchCount: OVERFETCH,
      workspaceId: opts.workspaceId,
      signal: opts.signal,
    }),
    retrieveExemplars({
      queryText: topic,
      wantViral: false,
      postType: opts.postType ?? null,
      excludeIds: opts.excludeIds,
      matchCount: OVERFETCH,
      workspaceId: opts.workspaceId,
      signal: opts.signal,
    }),
  ]);

  const bodies = await fetchBodies([
    ...viralMatches.map((m) => m.postId),
    ...mediocreMatches.map((m) => m.postId),
  ]);
  const withBody = (m: { postId: string }): { text: string } | null => {
    const text = bodies.get(m.postId);
    return text ? { text } : null;
  };

  const viral = diversify(
    viralMatches.map(withBody).filter((x): x is { text: string } => x !== null),
    VIRAL_SHOW,
  );
  const mediocre = diversify(
    mediocreMatches.map(withBody).filter((x): x is { text: string } => x !== null),
    MEDIOCRE_SHOW,
  );

  if (viral.length === 0 && mediocre.length === 0) {
    return { block: "", viralCount: 0, mediocreCount: 0 };
  }

  const trim = (t: string) =>
    t.length > EXEMPLAR_CHARS ? `${t.slice(0, EXEMPLAR_CHARS)}…` : t;

  const parts: string[] = [
    "",
    "For reference, here is how similar topics have performed with this audience. Learn the STRUCTURE and moves that worked — never copy their wording, claims, or stories:",
  ];
  if (viral.length > 0) {
    parts.push("", "WORKED (emulate the structure, not the content):");
    viral.forEach((v, i) => parts.push(`${i + 1}. """${trim(v.text)}"""`));
  }
  if (mediocre.length > 0) {
    parts.push("", "UNDERPERFORMED on this theme (avoid these moves):");
    mediocre.forEach((m, i) => parts.push(`${i + 1}. """${trim(m.text)}"""`));
  }

  return {
    block: parts.join("\n"),
    viralCount: viral.length,
    mediocreCount: mediocre.length,
  };
}
