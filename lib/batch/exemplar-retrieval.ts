import { supabaseAdmin } from "@/lib/supabase";
import {
  embedText,
  retrieveExemplars,
  type ExemplarMatch,
} from "@/lib/post-embeddings";
import type { PostType } from "@/lib/post-type";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  logOpenRouterUsage,
} from "@/lib/openrouter";
import {
  coworkAdapterHealth,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import { runCoworkAdapterAttempt } from "@/lib/agent/cowork-adapter-attempt";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import { wrapUntrustedDelimited } from "@/lib/agent/untrusted";

// Retrieval-augmented drafting (the viral-learning loop). Pull semantically
// nearest VIRAL posts (positive structural exemplars) and, for the legacy batch
// lane, MEDIOCRE posts on the same theme (negative patterns to avoid). Both
// come from the embedded LinkedIn corpus via cosine similarity.
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

export type RetrievedExemplar = {
  postId: string;
  similarity: number;
  lane: "viral" | "mediocre";
  text: string;
};

export type ExemplarBlock = {
  block: string;
  viralCount: number;
  mediocreCount: number;
  exemplars: RetrievedExemplar[];
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
async function fetchBodies(
  ids: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  signal?.throwIfAborted();
  const query = supabaseAdmin()
    .from("posts")
    .select("id, text")
    .in("id", ids);
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
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
  /** The direct writer uses only positive examples; batch keeps the legacy negative lane. */
  includeMediocre?: boolean;
  /** Optional cosine-similarity floor for callers that need topic relevance. */
  minSimilarity?: number;
  workspaceId?: string;
  signal?: AbortSignal;
  telemetry?: CoworkTurnTelemetry;
  adapterHealth?: AdapterHealthRegistry;
}): Promise<ExemplarBlock> {
  const topic = opts.topicText.trim();
  if (!topic) {
    return { block: "", viralCount: 0, mediocreCount: 0, exemplars: [] };
  }

  const includeMediocre = opts.includeMediocre !== false;
  const retrievalIdentity = includeMediocre
    ? {
        adapterKey: `cowork_legacy_exemplar_embedding:${EMBEDDING_MODEL}`,
        stage: "legacy_exemplar_embedding",
      }
    : {
        adapterKey: `cowork_linkedin_native_exemplar_embedding:${EMBEDDING_MODEL}`,
        stage: "linkedin_native_exemplar_embedding",
      };
  const embeddingAttempt = await runCoworkAdapterAttempt({
    registry: opts.adapterHealth ?? coworkAdapterHealth,
    adapterKey: retrievalIdentity.adapterKey,
    signal: opts.signal,
    call: () =>
      embedText([topic], {
        model: EMBEDDING_MODEL,
        signal: opts.signal,
      }),
    validate: (response) => {
      const vector = response.embeddings[0];
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
        throw new Error("Exemplar query embedding had an invalid shape.");
      }
      return vector;
    },
    persistUsage: (response) =>
      opts.workspaceId
        ? logOpenRouterUsage(
            "embed_posts",
            EMBEDDING_MODEL,
            {
              prompt_tokens: response.promptTokens,
              completion_tokens: 0,
            },
            opts.workspaceId,
            { count: 1 },
          )
        : Promise.resolve(),
    usage: (response) => ({
      prompt_tokens: response.promptTokens,
      completion_tokens: 0,
    }),
    telemetry: opts.telemetry,
    stage: retrievalIdentity.stage,
    attempt: 1,
    model: EMBEDDING_MODEL,
    rejectedReasonCode: "invalid_exemplar_embedding",
  });
  const queryEmbedding = embeddingAttempt.value;

  const [viralRetrieved, mediocreRetrieved] = await Promise.all([
    retrieveExemplars({
      queryText: topic,
      queryEmbedding,
      wantViral: true,
      postType: opts.postType ?? null,
      excludeIds: opts.excludeIds,
      matchCount: OVERFETCH,
      workspaceId: opts.workspaceId,
      signal: opts.signal,
    }),
    includeMediocre
      ? retrieveExemplars({
          queryText: topic,
          queryEmbedding,
          wantViral: false,
          postType: opts.postType ?? null,
          excludeIds: opts.excludeIds,
          matchCount: OVERFETCH,
          workspaceId: opts.workspaceId,
          signal: opts.signal,
        })
      : Promise.resolve([]),
  ]);
  const minSimilarity =
    typeof opts.minSimilarity === "number" && Number.isFinite(opts.minSimilarity)
      ? opts.minSimilarity
      : Number.NEGATIVE_INFINITY;
  const viralMatches = viralRetrieved.filter(
    (match) => match.similarity >= minSimilarity,
  );
  const mediocreMatches = mediocreRetrieved.filter(
    (match) => match.similarity >= minSimilarity,
  );

  const bodies = await fetchBodies([
    ...viralMatches.map((m) => m.postId),
    ...mediocreMatches.map((m) => m.postId),
  ], opts.signal);
  const withBody = (
    m: ExemplarMatch,
    lane: RetrievedExemplar["lane"],
  ): RetrievedExemplar | null => {
    const text = bodies.get(m.postId);
    return text
      ? {
          postId: m.postId,
          similarity: m.similarity,
          lane,
          text,
        }
      : null;
  };

  const viral = diversify(
    viralMatches
      .map((match) => withBody(match, "viral"))
      .filter((x): x is RetrievedExemplar => x !== null),
    VIRAL_SHOW,
  );
  const mediocre = diversify(
    mediocreMatches
      .map((match) => withBody(match, "mediocre"))
      .filter((x): x is RetrievedExemplar => x !== null),
    MEDIOCRE_SHOW,
  );

  if (viral.length === 0 && mediocre.length === 0) {
    return { block: "", viralCount: 0, mediocreCount: 0, exemplars: [] };
  }

  const trim = (t: string) =>
    t.length > EXEMPLAR_CHARS ? `${t.slice(0, EXEMPLAR_CHARS)}…` : t;

  const parts: string[] = [
    "",
    "For reference, here is how similar topics have performed with this audience. Learn the STRUCTURE and moves that worked — never copy their wording, claims, or stories:",
  ];
  if (viral.length > 0) {
    parts.push("", "WORKED (emulate the structure, not the content):");
    viral.forEach((v, i) =>
      parts.push(
        `${i + 1}. ${wrapUntrustedDelimited({
          label: `LINKEDIN VIRAL EXEMPLAR ${i + 1}`,
          endLabel: `END LINKEDIN VIRAL EXEMPLAR ${i + 1}`,
          text: trim(v.text),
        })}`,
      ),
    );
  }
  if (mediocre.length > 0) {
    parts.push("", "UNDERPERFORMED on this theme (avoid these moves):");
    mediocre.forEach((m, i) =>
      parts.push(
        `${i + 1}. ${wrapUntrustedDelimited({
          label: `LINKEDIN UNDERPERFORMED EXEMPLAR ${i + 1}`,
          endLabel: `END LINKEDIN UNDERPERFORMED EXEMPLAR ${i + 1}`,
          text: trim(m.text),
        })}`,
      ),
    );
  }

  return {
    block: parts.join("\n"),
    viralCount: viral.length,
    mediocreCount: mediocre.length,
    exemplars: [...viral, ...mediocre],
  };
}
