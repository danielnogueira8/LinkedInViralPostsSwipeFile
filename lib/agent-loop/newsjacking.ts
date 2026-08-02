import type { SupabaseClient } from "@supabase/supabase-js";
import {
  filterFreshNews,
  searchNews,
  type NewsResult,
} from "@/lib/news-search";
import {
  MONTHLY_BUDGET_USD,
  NEWS_SEARCH_COST_RESERVE_USD,
} from "@/lib/agent/rate-limit";
import {
  claimWorkspaceCost,
  releaseWorkspaceCost,
} from "@/lib/workspace-cost-claims";
import { claimAgentLoopDailyRun } from "@/lib/agent-loop/daily-run";
import {
  synthesizeNewsOpportunities,
  type NewsOpportunitySynthesis,
  type SynthesizedNewsOpportunity,
} from "@/lib/agent-loop/news-opportunity-synthesis";
import { loadAgentDismissalFeedback } from "@/lib/agent-inbox/feedback";
import { selectRefinedCandidates } from "@/lib/agent-inbox/opportunity-quality";

// Newsjacking is deliberately broader than the tracked-creator scanner. It
// looks for fresh, web-grounded developments that could become a post idea
// before any creator in the workspace has written about them.
export const NEWS_MAX_AGE_DAYS = 7;
const NEWS_EXPIRE_AFTER_DAYS = 5;
const NEWS_COOLDOWN_DAYS = 30;
const MAX_NEWSJACKING_OPPORTUNITIES_PER_RUN = 3;
const NEWS_SEARCH_BUCKET_MS = 24 * 60 * 60 * 1000;

const QUERY_LANE =
  "LinkedIn platform changes, official announcements, AI-generated content and AI slop, creator economy, work, technology, and notable cultural conversations";

export type NewsjackingOpportunityPayload = {
  signal_type?: "newsjacking";
  headline?: string;
  summary?: string;
  source_url?: string;
  source_name?: string;
  published_at?: string;
  signal_state?: "early";
  creator_coverage?: "none_observed" | "observed";
  reason?: "creator_independent" | "verified_external_event";
  trend_key?: string;
  angle_prompt?: string;
  viral_mechanism?: string;
  dismiss_reason?: string;
  corroborating_sources?: Array<{
    title?: string;
    source?: string;
    url?: string;
  }>;
};

export type NewsjackingCandidate = {
  result: NewsResult;
  corroboratingResults?: NewsResult[];
  score: number;
  trendKey: string;
};

export type ScanNewsjackingResult = {
  searched: number;
  fetched: number;
  inserted: number;
  expired: number;
  skipped: number;
};

export type ScanNewsjackingOptions = {
  /** Explicit maintenance/manual triggers may intentionally rerun a pass. */
  allowRepeat?: boolean;
  synthesize?: NewsOpportunitySynthesis;
};

export function newsjackingOperationKey(
  workspaceId: string,
  now = new Date(),
): string {
  return `newsjacking:${workspaceId}:${Math.floor(
    now.getTime() / NEWS_SEARCH_BUCKET_MS,
  )}`;
}

const NEWS_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "latest",
  "new",
  "of",
  "on",
  "the",
  "to",
  "with",
]);
const NEWS_GENERIC_WORDS = new Set([
  "announcement",
  "announces",
  "change",
  "changes",
  "feature",
  "introduce",
  "introduced",
  "introduces",
  "label",
  "latest",
  "platform",
  "release",
  "update",
  "updates",
]);
const SENSITIVE_NEWSJACKING_RE =
  /\b(?:death|deaths|died|killed|murder|war|terror(?:ism|ist)?|mass shooting|shooting|earthquake|hurricane|flood|disaster|tragedy|hostage|genocide|violence|violent|human suffering)\b/i;

function normaliseTopic(topic: string): string {
  return topic.replace(/\s+/g, " ").trim().slice(0, 100);
}

function topicTokens(topics: readonly string[]): string[] {
  return [
    ...new Set(
      topics
        .flatMap((topic) =>
          normaliseTopic(topic)
            .toLowerCase()
            .split(/[^a-z0-9]+/),
        )
        .filter((token) => token.length > 2 && !NEWS_STOP_WORDS.has(token)),
    ),
  ];
}

function signalTokens(result: NewsResult): string[] {
  return [
    ...new Set(
      `${result.title} ${result.summary}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(
          (token) =>
            token.length > 1 &&
            !NEWS_STOP_WORDS.has(token) &&
            !NEWS_GENERIC_WORDS.has(token),
        ),
    ),
  ];
}

function isUsableHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isSocialPostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "x.com" || host.endsWith(".x.com")) return true;
    if (host === "twitter.com" || host.endsWith(".twitter.com")) return true;
    return (
      (host === "linkedin.com" || host.endsWith(".linkedin.com")) &&
      !host.startsWith("news.") &&
      /\/(?:posts|feed\/update|pulse)\//.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

const ESTABLISHED_VERIFICATION_HOSTS = [
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "bloomberg.com",
  "cnbc.com",
  "ft.com",
  "theguardian.com",
  "nytimes.com",
  "reuters.com",
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "wsj.com",
  "news.linkedin.com",
  "about.fb.com",
  "ai.google",
  "anthropic.com",
  "blog.google",
  "github.blog",
  "google.com",
  "linkedin.com",
  "blogs.microsoft.com",
  "news.microsoft.com",
  "support.microsoft.com",
  "microsoft.com",
  "help.openai.com",
  "platform.openai.com",
  "openai.com",
] as const;

function hostnameMatches(hostname: string, expected: string): boolean {
  return hostname === expected;
}

function isAuthoritativeVerification(result: NewsResult): boolean {
  if (!isUsableHttpUrl(result.url) || isSocialPostUrl(result.url)) return false;

  const parsed = new URL(result.url);
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (
    hostname.endsWith(".gov") ||
    hostname.endsWith(".edu") ||
    ESTABLISHED_VERIFICATION_HOSTS.some((host) =>
      hostnameMatches(hostname, host),
    )
  ) {
    return true;
  }

  return false;
}

/** Stable enough for a 30-day opportunity cooldown and same-run deduping. */
export function newsjackingKeyForResult(
  result: Pick<NewsResult, "title" | "url">,
): string {
  const titleKey = result.title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\blinkedin\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token && !NEWS_STOP_WORDS.has(token))
    .slice(0, 14)
    .join("-");
  if (titleKey) return `title:${titleKey}`.slice(0, 180);

  try {
    const parsed = new URL(result.url);
    return `url:${parsed.hostname}${parsed.pathname}`
      .toLowerCase()
      .slice(0, 180);
  } catch {
    return `url:${result.url.toLowerCase()}`.slice(0, 180);
  }
}

export function buildNewsjackingQuery(topics: readonly string[]): string {
  const topicContext = topics
    .map(normaliseTopic)
    .filter(Boolean)
    .slice(0, 12)
    .join(", ");
  return (
    `Search the live web for fresh developments that could become timely LinkedIn newsjacking ideas. ` +
    `Use current, verifiable events whether or not tracked creators have posted about them. ` +
    `Cover ${QUERY_LANE}. ` +
    (topicContext
      ? `Prioritise these workspace topics when relevant: ${topicContext}. `
      : "") +
    `Include corroborating LinkedIn creator posts or public X posts when search can verify them, while using primary or established sources to verify the underlying event. ` +
    `Return developments with a clear factual change, announcement, or conversation that a professional could add an original perspective to. ` +
    `For LinkedIn product or policy changes, prefer LinkedIn News, official LinkedIn pages, or Microsoft documentation; otherwise prefer primary or established sources and include the publication date.`
  );
}

export function scoreNewsjackingSignal(
  result: NewsResult,
  topics: readonly string[],
  now: Date,
): number {
  const publishedMs = Date.parse(result.published_at);
  const ageDays = Number.isFinite(publishedMs)
    ? Math.max(0, (now.getTime() - publishedMs) / (24 * 60 * 60 * 1000))
    : NEWS_MAX_AGE_DAYS;
  const freshness = Math.max(0, 1 - ageDays / NEWS_MAX_AGE_DAYS);
  const haystack = `${result.title} ${result.summary}`.toLowerCase();
  const tokens = topicTokens(topics);
  const topicMatches = tokens.filter((token) =>
    haystack.includes(token),
  ).length;
  const topicFit =
    tokens.length > 0 ? Math.min(1, topicMatches / tokens.length) : 0;

  let firstParty = 0;
  try {
    const hostname = new URL(result.url).hostname.toLowerCase();
    if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) {
      firstParty = 1;
    }
  } catch {
    // Invalid URLs are removed before this scoring function is used.
  }
  if (result.source.toLowerCase().includes("linkedin")) firstParty = 1;

  return Number((freshness * 4 + topicFit * 3 + firstParty * 2).toFixed(4));
}

/**
 * Public discovery seam: freshness, URL grounding, same-event deduplication,
 * and ranking happen before anything is persisted as an opportunity.
 */
export function rankNewsjackingCandidates(
  results: NewsResult[],
  now: Date,
  topics: readonly string[],
): NewsjackingCandidate[] {
  const groupedByKey = new Map<string, NewsResult[]>();
  for (const result of filterFreshNews(results, now, NEWS_MAX_AGE_DAYS)) {
    if (
      !isUsableHttpUrl(result.url) ||
      !result.summary.trim() ||
      SENSITIVE_NEWSJACKING_RE.test(`${result.title} ${result.summary}`)
    ) {
      continue;
    }
    const key = newsjackingKeyForResult(result);
    groupedByKey.set(key, [...(groupedByKey.get(key) ?? []), result]);
  }
  const candidates: NewsjackingCandidate[] = [];
  for (const [trendKey, grouped] of groupedByKey) {
    const ranked = [...grouped].sort(
      (left, right) =>
        scoreNewsjackingSignal(right, topics, now) -
        scoreNewsjackingSignal(left, topics, now),
    );
    // Social posts are useful corroboration, not sufficient event proof. Keep
    // an authoritative/established result as the primary evidence source.
    const result = ranked.find(isAuthoritativeVerification);
    if (!result) continue;
    candidates.push({
      result,
      corroboratingResults: ranked.filter((entry) => entry !== result),
      score: scoreNewsjackingSignal(result, topics, now),
      trendKey,
    });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

export function newsjackingOpportunityPayload(
  result: NewsResult,
  topics: readonly string[],
  _now: Date,
  creatorCoverage: "none_observed" | "observed" = "none_observed",
  synthesis?: SynthesizedNewsOpportunity,
  corroboratingResults: readonly NewsResult[] = [],
): NewsjackingOpportunityPayload {
  const topic = topics.map(normaliseTopic).find(Boolean) ?? "your audience";
  return {
    signal_type: "newsjacking",
    headline: synthesis?.headline ?? result.title.trim().slice(0, 300),
    summary: result.summary.trim().slice(0, 1000),
    source_url: result.url.trim().slice(0, 1000),
    source_name: result.source.trim().slice(0, 120),
    published_at: result.published_at.trim().slice(0, 40),
    signal_state: "early",
    creator_coverage: creatorCoverage,
    reason: "verified_external_event",
    trend_key: newsjackingKeyForResult(result),
    angle_prompt:
      synthesis?.angle ??
      `“${result.title.trim()}” → identify the concrete consequence or changed decision for ${topic}; add only an original claim the source supports.`,
    ...(synthesis?.viralMechanism
      ? { viral_mechanism: synthesis.viralMechanism }
      : {}),
    corroborating_sources: corroboratingResults.slice(0, 4).map((entry) => ({
      title: entry.title,
      source: entry.source,
      url: entry.url,
    })),
  };
}

export function newsjackingEvidenceText(
  payload: NewsjackingOpportunityPayload | null | undefined,
): string {
  const value = payload ?? {};
  return [
    "NEWSJACKING EVIDENCE",
    `Headline: ${value.headline ?? "Untitled signal"}`,
    `What happened: ${value.summary ?? "No summary was supplied."}`,
    `Published: ${value.published_at ?? "Unknown"}`,
    `Source: ${value.source_name ?? "Unknown source"}`,
    `Source URL: ${value.source_url ?? "Unknown URL"}`,
    `Tracked creator coverage at detection time: ${
      value.creator_coverage === "observed" ? "observed" : "none observed"
    }.`,
  ].join("\n");
}

type WorkspaceContext = {
  topics: string[];
  accountIds: string[];
};

async function workspaceContext(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const { data, error } = await sb
    .from("workspace_accounts")
    .select("account_id, niche")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return {
    topics: [
      ...new Set(
        (data ?? [])
          .map((row) =>
            typeof row.niche === "string" ? normaliseTopic(row.niche) : "",
          )
          .filter(Boolean),
      ),
    ],
    accountIds: [
      ...new Set(
        (data ?? [])
          .map((row) =>
            typeof row.account_id === "string" ? row.account_id : "",
          )
          .filter(Boolean),
      ),
    ],
  };
}

async function trackedCreatorPostTexts(
  sb: SupabaseClient,
  accountIds: readonly string[],
  now: Date,
): Promise<string[]> {
  if (accountIds.length === 0) return [];
  const cutoff = new Date(
    now.getTime() - NEWS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await sb
    .from("posts")
    .select("text")
    .in("account_id", accountIds)
    .gte("posted_at", cutoff)
    .limit(2000);
  if (error) throw error;
  return (data ?? [])
    .map((row) => (typeof row.text === "string" ? row.text : ""))
    .filter(Boolean);
}

/** True when a tracked creator's recent post appears to cover this signal. */
export function hasCreatorCoverage(
  result: NewsResult,
  trackedPostTexts: readonly string[],
): boolean {
  const tokens = signalTokens(result);
  if (tokens.length === 0) return false;
  const requiredMatches = tokens.length >= 2 ? 2 : 1;
  return trackedPostTexts.some((text) => {
    const lower = text.toLowerCase();
    return (
      tokens.filter((token) => lower.includes(token)).length >= requiredMatches
    );
  });
}

export async function scanNewsjackingOpportunities(
  sb: SupabaseClient,
  workspaceId: string,
  now = new Date(),
  options: ScanNewsjackingOptions = {},
): Promise<ScanNewsjackingResult> {
  if (!options.allowRepeat) {
    const claimed = await claimAgentLoopDailyRun(sb, workspaceId, now);
    if (!claimed) {
      return {
        searched: 0,
        fetched: 0,
        inserted: 0,
        expired: 0,
        skipped: 1,
      };
    }
  }

  const expireCutoff = new Date(
    now.getTime() - NEWS_EXPIRE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: expiredRows, error: expireError } = await sb
    .from("agent_opportunities")
    .update({ status: "expired", acted_at: now.toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("kind", "news")
    .in("status", ["proposed", "drafting", "snoozed"])
    .lt("created_at", expireCutoff)
    .select("id");
  if (expireError) throw expireError;

  const context = await workspaceContext(sb, workspaceId);
  const topics = context.topics;
  const cooldownCutoff = new Date(
    now.getTime() - NEWS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent, error: recentError } = await sb
    .from("agent_opportunities")
    .select("trend_key, payload")
    .eq("workspace_id", workspaceId)
    .eq("kind", "news")
    .gte("created_at", cooldownCutoff);
  if (recentError) throw recentError;
  const recentKeys = new Set(
    (recent ?? [])
      .map((row) => {
        if (typeof row.trend_key === "string") return row.trend_key;
        const payload = row.payload as NewsjackingOpportunityPayload | null;
        return typeof payload?.trend_key === "string"
          ? payload.trend_key
          : null;
      })
      .filter((key): key is string => Boolean(key)),
  );
  const feedback = await loadAgentDismissalFeedback(sb, workspaceId);

  const query = buildNewsjackingQuery(topics);
  const operationKey = newsjackingOperationKey(workspaceId, now);
  const costClaim = await claimWorkspaceCost({
    workspaceId,
    operationKey,
    estimatedCostUsd: NEWS_SEARCH_COST_RESERVE_USD,
    budgetUsd: MONTHLY_BUDGET_USD,
    ttlSeconds: 15 * 60,
    sb,
  });
  if (!costClaim) {
    return {
      searched: 0,
      fetched: 0,
      inserted: 0,
      expired: (expiredRows ?? []).length,
      skipped: 1,
    };
  }

  let search: Awaited<ReturnType<typeof searchNews>>;
  try {
    search = await searchNews({
      query,
      workspaceId,
      now,
    });
  } finally {
    await releaseWorkspaceCost({ workspaceId, operationKey, sb }).catch(
      (error) => {
        console.error("Failed to release Newsjacking cost claim", error);
      },
    );
  }
  const trackedPosts = await trackedCreatorPostTexts(
    sb,
    context.accountIds,
    now,
  );
  const candidates = rankNewsjackingCandidates(search.results, now, topics)
    .filter((candidate) => !recentKeys.has(candidate.trendKey))
    .slice(0, Math.max(MAX_NEWSJACKING_OPPORTUNITIES_PER_RUN * 2, 6));
  const synthesisResult = await (
    options.synthesize ?? synthesizeNewsOpportunities
  )({
    workspaceId,
    topics,
    candidates,
    feedback: feedback.map(
      (entry) => `${entry.lane}: ${entry.reason} — ${entry.headline}`,
    ),
  });
  const selectedCandidates = synthesisResult.available
    ? selectRefinedCandidates({
        candidates,
        opportunities: synthesisResult.opportunities,
        key: (candidate) => candidate.trendKey,
        limit: MAX_NEWSJACKING_OPPORTUNITIES_PER_RUN,
      })
    : [];

  let inserted = 0;
  let skipped = synthesisResult.available ? 0 : candidates.length;
  for (const candidate of selectedCandidates) {
    const synthesis = synthesisResult.opportunities.get(candidate.trendKey);
    const payload = newsjackingOpportunityPayload(
      candidate.result,
      topics,
      now,
      hasCreatorCoverage(candidate.result, trackedPosts)
        ? "observed"
        : "none_observed",
      synthesis,
      candidate.corroboratingResults ?? [],
    );
    const { error } = await sb.from("agent_opportunities").insert({
      workspace_id: workspaceId,
      kind: "news",
      trend_key: candidate.trendKey,
      source_post_id: null,
      status: "proposed",
      score: synthesis?.score ?? candidate.score,
      payload,
    });
    if (error) {
      if (!String(error.message).includes("duplicate key")) {
        console.warn(
          "scanNewsjackingOpportunities insert failed:",
          error.message,
        );
      }
      skipped += 1;
      continue;
    }
    inserted += 1;
  }

  return {
    searched: search.searched,
    fetched: search.results.length,
    inserted,
    expired: (expiredRows ?? []).length,
    skipped,
  };
}
