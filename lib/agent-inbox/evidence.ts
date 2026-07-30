import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AgentInboxEvidence,
  AgentInboxEvidenceBundle,
  AgentInboxLane,
  AgentInboxPreferences,
} from "@/lib/agent-inbox";
import { searchNews, type NewsResult } from "@/lib/news-search";
import {
  firstSentence,
  truncateAtSentenceBoundary,
  truncateAtWordBoundary,
} from "@/lib/text-truncate";

const SENSITIVE_NEWS_RE =
  /\b(?:killed|death|dead|fatal|shooting|war|earthquake|flood|wildfire|hurricane|terror|assault|abuse|tragedy)\b/i;

// Word-boundary cut: these strings land verbatim in the draft prompt, and a
// raw slice leaves dangling fragments ("…before your content ge").
function clean(value: unknown, max = 600): string | null {
  if (typeof value !== "string") return null;
  const result = truncateAtWordBoundary(
    value.replace(/\s+/g, " ").trim(),
    max,
  );
  return result || null;
}

// Prose variant for multi-sentence details: cut at a sentence end so the
// prompt never shows a thought that stops mid-clause ("…analytics. Here's").
function cleanProse(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = truncateAtSentenceBoundary(
    value.replace(/\s+/g, " ").trim(),
    max,
  );
  return result || null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function newsAgeDays(preferences: AgentInboxPreferences): number {
  if (preferences.newsSensitivity === "low") return 3;
  if (preferences.newsSensitivity === "high") return 14;
  return 7;
}

function newsEvidence(
  results: NewsResult[],
  now: Date,
  preferences: AgentInboxPreferences,
): AgentInboxEvidence[] {
  const cutoff = now.getTime() - newsAgeDays(preferences) * 86_400_000;
  return results
    .filter((result) => {
      const timestamp = Date.parse(result.published_at);
      return (
        Number.isFinite(timestamp) &&
        timestamp >= cutoff &&
        !SENSITIVE_NEWS_RE.test(`${result.title} ${result.summary}`)
      );
    })
    .slice(0, 5)
    .map((result) => ({
      kind: "news" as const,
      label: result.title,
      detail: result.summary,
      url: result.url,
      publishedAt: result.published_at,
      ref: result.source,
    }));
}

function sharedNewsKey(query: string): string {
  return createHash("sha256")
    .update(query.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim())
    .digest("hex");
}

async function sharedNews(
  db: SupabaseClient,
  query: string | null,
  workspaceId: string,
  now: Date,
  preferences: AgentInboxPreferences,
): Promise<AgentInboxEvidence[]> {
  if (!query) return [];
  const key = sharedNewsKey(query);
  const { data: cached, error: cacheError } = await db
    .from("agent_news_pool")
    .select("results, expires_at")
    .eq("cluster_key", key)
    .gt("expires_at", now.toISOString())
    .maybeSingle();
  if (cacheError) throw cacheError;
  if (Array.isArray(cached?.results)) {
    return newsEvidence(cached.results as NewsResult[], now, preferences);
  }

  // The pool is shared by normalized topic cluster. Usage remains attributable
  // to the first Workspace that fills a cold key; every later Workspace reads
  // the cached result instead of repeating the paid search.
  const searched = await searchNews({
    query,
    workspaceId,
    now,
    deadlineAtMs: Date.now() + 100_000,
  });
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const { error: upsertError } = await db.from("agent_news_pool").upsert(
    {
      cluster_key: key,
      query,
      results: searched.results,
      searched_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: "cluster_key" },
  );
  if (upsertError) throw upsertError;
  return newsEvidence(searched.results, now, preferences);
}

type LearningSignalRow = {
  kind?: unknown;
  label?: unknown;
  score?: unknown;
  confidence?: unknown;
  sampleSize?: unknown;
  representativeExample?: unknown;
};

function learningEvidence(signals: unknown): AgentInboxEvidence[] {
  if (!Array.isArray(signals)) return [];
  return (signals as LearningSignalRow[])
    .flatMap((signal) => {
      const label = clean(signal.label, 240);
      if (!label || typeof signal.score !== "number" || signal.score <= 0)
        return [];
      return [
        {
          kind: "performance" as const,
          label,
          detail: [
            typeof signal.score === "number"
              ? `signal score ${signal.score.toFixed(2)}`
              : null,
            typeof signal.sampleSize === "number"
              ? `seen across ${signal.sampleSize} posts`
              : null,
            cleanProse(signal.representativeExample, 260)
              ? `example: ${cleanProse(signal.representativeExample, 260)}`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          ref: clean(signal.kind, 80),
          score:
            typeof signal.score === "number"
              ? signal.score
              : Number.NEGATIVE_INFINITY,
          confidence:
            typeof signal.confidence === "number" ? signal.confidence : 0,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score || right.confidence - left.confidence,
    )
    .slice(0, 8)
    .map((entry) => ({
      kind: entry.kind,
      label: entry.label,
      detail: entry.detail,
      ref: entry.ref,
    }));
}

function knowledgeDetail(kind: string, content: unknown): string {
  const value = record(content);
  const fields: Record<string, string[]> = {
    story: ["summary", "details"],
    belief: ["statement", "rationale"],
    proof: ["claim", "evidence"],
    offer: ["name", "promise"],
    audience_insight: ["audience", "insight"],
    topic_expertise: ["topic", "basis"],
    prohibition: ["claim", "reason"],
  };
  const joined = (fields[kind] ?? Object.keys(value))
    .map((field) => clean(value[field], 500))
    .filter(Boolean)
    .join(" — ");
  return truncateAtWordBoundary(joined, 900);
}

async function loadLearning(
  db: SupabaseClient,
  workspaceId: string,
): Promise<AgentInboxEvidence[]> {
  const { data, error } = await db
    .from("workspace_learning_snapshots")
    .select("signals")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return learningEvidence(data?.signals);
}

async function loadKnowledge(
  db: SupabaseClient,
  workspaceId: string,
): Promise<AgentInboxEvidence[]> {
  const { data, error } = await db
    .from("workspace_knowledge_items")
    .select("id, kind, title, content")
    .eq("workspace_id", workspaceId)
    .eq("verification", "verified")
    .eq("active", true)
    .neq("kind", "prohibition")
    .order("updated_at", { ascending: false })
    .limit(12);
  if (error) throw error;
  return (data ?? []).flatMap((row) => {
    const label = clean(row.title, 240);
    const detail = knowledgeDetail(String(row.kind), row.content);
    if (!label || !detail) return [];
    return [
      {
        kind: "knowledge" as const,
        label,
        detail,
        ref: String(row.id),
      },
    ];
  });
}

async function loadRecentPosts(
  db: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<AgentInboxEvidence[]> {
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const { data, error } = await db
    .from("chat_artifacts")
    .select("id, title, body, created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) throw error;
  return (data ?? []).flatMap((row) => {
    const storedTitle = clean(row.title, 240);
    const flatBody = String(row.body ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const hook = firstSentence(flatBody, 240) || null;
    // Legacy artifact titles were the body's first 60 chars sliced mid-word
    // ("…before your content ge"). When the body starts with the stored
    // title (ignoring its possibly-truncated last word), re-derive the label
    // from the body's opening sentence so the prompt shows the complete
    // thought instead of the dangling fragment.
    const titleStem = storedTitle?.replace(/\s+\S*$/, "") ?? "";
    const label =
      storedTitle && titleStem && flatBody.startsWith(titleStem)
        ? (hook ?? storedTitle)
        : (storedTitle ?? hook);
    if (!label) return [];
    return [
      {
        kind: "source_post" as const,
        label,
        detail: cleanProse(row.body, 500) ?? "",
        ref: String(row.id),
      },
    ];
  });
}

async function topicQuery(
  db: SupabaseClient,
  workspaceId: string,
  preferences: AgentInboxPreferences,
  learning: AgentInboxEvidence[],
  knowledge: AgentInboxEvidence[],
): Promise<string | null> {
  const explicit = preferences.topics.filter(Boolean).slice(0, 4);
  const learned = learning
    .filter((entry) => entry.ref === "topic")
    .map((entry) => entry.label)
    .slice(0, 3);
  const known = knowledge.map((entry) => entry.label).slice(0, 2);
  let topics = explicit.length ? explicit : learned.length ? learned : known;
  if (topics.length === 0) {
    const { data, error } = await db
      .from("workspace_accounts")
      .select("niche, accounts(niche)")
      .eq("workspace_id", workspaceId)
      .limit(20);
    if (error) throw error;
    topics = (data ?? [])
      .flatMap((row) => {
        const account = Array.isArray(row.accounts)
          ? row.accounts[0]
          : row.accounts;
        return [clean(row.niche, 120), clean(account?.niche, 120)];
      })
      .filter((value): value is string => Boolean(value))
      .slice(0, 3);
  }
  if (topics.length === 0) return null;
  return `${[...new Set(topics)].join(" OR ")} latest announcements, product changes, research, and industry developments`;
}

// The niche query above can only ever return trade press, because every path
// that fills `topics` resolves to the user's own field and the trailing clause
// pins it to industry developments. That makes the strongest newsjacking
// framing structurally unreachable: the event a post borrows attention from
// usually is NOT niche news — it is a moment the whole audience already has an
// opinion about (a final, an awards night, a film, a platform change everyone
// is arguing about). Adapting it to the niche is the creative work; finding it
// is not something a niche-scoped search can do.
//
// So this runs as a SECOND, deliberately niche-free search. It carries no
// workspace terms at all, which is also why it caches well: every workspace
// normalizes to the same cluster key, so the whole product pays for one search
// per 12-hour window rather than one per workspace.
//
// Deliberately excluded: politics, crime, disaster, and conflict. Those are
// culturally loud and are exactly the events where borrowing attention reads
// as opportunistic. SENSITIVE_NEWS_RE still filters results defensively, but
// not asking is better than filtering after the fact.
const CULTURAL_MOMENT_QUERY =
  "major sports finals, awards shows, entertainment releases, and widely discussed technology or internet culture moments this week";

export function culturalMomentQuery(): string {
  return CULTURAL_MOMENT_QUERY;
}

// Two pools can legitimately surface the same story — a platform change is
// both industry news and a moment everyone is discussing. Without this the
// synthesizer would see one article twice and could build two cards on it,
// the exact duplicate-pitch problem the source guard exists to prevent.
// First occurrence wins, so the niche pool keeps precedence.
export function dedupeNewsEvidence(
  entries: AgentInboxEvidence[],
): AgentInboxEvidence[] {
  const seen = new Set<string>();
  const out: AgentInboxEvidence[] = [];
  for (const entry of entries) {
    const key = entry.url ?? entry.ref ?? entry.label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// A news story already pitched in the last few days must not come back as a
// "fresh" opportunity — nothing makes the agent feel dumber than re-offering
// the same article every morning. Matches the news eligibility window
// (standard sensitivity = 7 days), so a story can only return once it would
// have aged out anyway.
const NEWS_REUSE_WINDOW_MS = 7 * 86_400_000;

async function loadUsedNewsSources(
  db: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<Set<string>> {
  const since = new Date(now.getTime() - NEWS_REUSE_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("agent_inbox_ideas")
    .select("source_url, source_ref")
    .eq("workspace_id", workspaceId)
    .eq("source_kind", "news")
    .gte("created_at", since);
  if (error) throw error;
  const used = new Set<string>();
  for (const row of data ?? []) {
    const url = (row as { source_url?: unknown }).source_url;
    const ref = (row as { source_ref?: unknown }).source_ref;
    if (typeof url === "string" && url) used.add(url);
    if (typeof ref === "string" && ref) used.add(ref);
  }
  return used;
}

export function createAgentInboxEvidenceLoader(db: SupabaseClient) {
  return async (input: {
    workspaceId: string;
    preferences: AgentInboxPreferences;
    missingLanes: AgentInboxLane[];
    now: Date;
  }): Promise<AgentInboxEvidenceBundle> => {
    const [learning, knowledge, recent] = await Promise.all([
      loadLearning(db, input.workspaceId),
      loadKnowledge(db, input.workspaceId),
      loadRecentPosts(db, input.workspaceId, input.now),
    ]);
    const query = input.missingLanes.includes("newsjacking")
      ? await topicQuery(
          db,
          input.workspaceId,
          input.preferences,
          learning,
          knowledge,
        )
      : null;
    // Timely discovery is additive. A search-provider outage must not prevent
    // the evidence already in this Workspace from producing the other lanes,
    // and one failing query must not take the other down with it — so each
    // search absorbs its own failure.
    const searchNewsPool = (label: string, poolQuery: string | null) =>
      sharedNews(
        db,
        poolQuery,
        input.workspaceId,
        input.now,
        input.preferences,
      ).catch((error) => {
        console.error("[agent-inbox:news]", {
          workspaceId: input.workspaceId,
          query: label,
          message: error instanceof Error ? error.message : "Search failed",
        });
        return [] as AgentInboxEvidence[];
      });
    // Niche trade press and culturally-relevant moments are two different
    // pools, searched in parallel. The cultural one has no workspace terms, so
    // it is the same cluster key for everyone and is usually a cache read.
    const [nicheNews, culturalNews] = input.missingLanes.includes("newsjacking")
      ? await Promise.all([
          searchNewsPool("niche", query),
          searchNewsPool("cultural", culturalMomentQuery()),
        ])
      : [[], []];
    // Niche first: when both pools return, a story from the user's own field
    // is the safer opening, and the cultural pool is the one that widens what
    // is reachable rather than replacing what already worked.
    const news = dedupeNewsEvidence([...nicheNews, ...culturalNews]);
    const freshNews = news.length
      ? await (async () => {
          const used = await loadUsedNewsSources(
            db,
            input.workspaceId,
            input.now,
          );
          return news.filter(
            (item) =>
              !(item.url && used.has(item.url)) &&
              !(item.ref && used.has(item.ref)),
          );
        })()
      : news;
    return { news: freshNews, learning, knowledge, recent };
  };
}
