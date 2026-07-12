import {
  completeChat,
  logOpenRouterUsage,
  SUPPORTED_NEWS_MODELS,
  type ToolDef,
} from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// News search for newsjacking. The newsjacking skill needs REAL, RECENT news —
// the chat model's training data is stale and it happily hallucinates
// "announcements". This module grounds it: one OpenRouter web-discovery call
// (Exa-backed), followed by a separate structured normalization call,
// then a strict freshness filter (default ≤14 days) so a
// stale or undated story can never be presented to the agent as "news".
//
// The 14-day rule is enforced in two layers here (plus the skill prompt):
//   1. The search prompt names today's date and asks for the last N days only.
//   2. filterFreshNews drops anything older than N days OR with a missing/
//      unparseable published date — an undated story can't be verified fresh,
//      so it doesn't qualify. (Pure + exported for tests.)
// ---------------------------------------------------------------------------

export type NewsResult = {
  title: string;
  url: string;
  source: string;
  published_at: string; // ISO date (YYYY-MM-DD) as reported by the search
  summary: string;
};

// Window (days) a story may be old and still count as newsjackable.
export const NEWS_MAX_AGE_DAYS = (() => {
  const n = Number(process.env.NEWS_MAX_AGE_DAYS ?? 14);
  return Number.isFinite(n) && n > 0 ? n : 14;
})();

// How many web results the plugin fetches (Exa bills per result: $4/1k, so 5
// results ≈ $0.02/search). Also the max stories returned to the agent.
export const NEWS_MAX_RESULTS = 5;

// News search is a two-call pipeline (grounded discovery + structured
// normalization), so a premium reasoning model compounds quickly. Haiku is the
// default because live A/B testing found the correct sources at roughly a
// quarter of Gemini Flash Lite's native-search cost while returning normal URLs
// the pipeline could preserve. The final post still uses the main chat model.
export const DEFAULT_NEWS_MODEL = "anthropic/claude-haiku-4.5";

export function resolveNewsModel(
  env: { OPENROUTER_NEWS_MODEL?: string } = {
    OPENROUTER_NEWS_MODEL: process.env.OPENROUTER_NEWS_MODEL,
  },
): string {
  const configured = env.OPENROUTER_NEWS_MODEL?.trim();
  return configured && SUPPORTED_NEWS_MODELS.includes(configured)
    ? configured
    : DEFAULT_NEWS_MODEL;
}

const NEWS_MODEL = resolveNewsModel();

// Structured output contract for the search call. Forcing this tool means we
// parse JSON, never prose.
const NEWS_RESULTS_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "report_news_results",
    description: "Report the news stories found, newest first.",
    parameters: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              source: { type: "string", description: "Publication name, e.g. 'TechCrunch'." },
              published_at: {
                type: "string",
                description: "Publication date as YYYY-MM-DD. Omit the story entirely if you cannot determine it.",
              },
              summary: { type: "string", description: "2-3 sentence factual summary of what happened." },
            },
            required: ["title", "url", "source", "published_at", "summary"],
          },
        },
      },
      required: ["results"],
    },
  },
};

// Drop results that aren't verifiably fresh: missing/unparseable dates fail
// closed (a story we can't date can't be trusted as ≤N days old), and anything
// strictly older than maxAgeDays is out. A small future tolerance (1 day) is
// allowed for timezone skew in publisher dates. Pure over `now` for tests.
export function filterFreshNews(
  results: NewsResult[],
  now: Date,
  maxAgeDays: number = NEWS_MAX_AGE_DAYS,
): NewsResult[] {
  const nowMs = now.getTime();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const futureToleranceMs = 24 * 60 * 60 * 1000;
  return results.filter((r) => {
    if (!r?.published_at || !r.url || !r.title) return false;
    const t = Date.parse(r.published_at);
    if (!Number.isFinite(t)) return false;
    const age = nowMs - t;
    return age <= maxAgeMs && age >= -futureToleranceMs;
  });
}

// Coerce whatever the model reported into clean NewsResult rows (defensive:
// forced tool output is schema-validated by the provider, but providers vary).
function sanitizeResults(raw: unknown): NewsResult[] {
  if (!raw || typeof raw !== "object") return [];
  const arr = (raw as { results?: unknown }).results;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      title: String(r.title ?? "").slice(0, 300),
      url: String(r.url ?? "").slice(0, 1000),
      source: String(r.source ?? "").slice(0, 120),
      published_at: String(r.published_at ?? "").slice(0, 40),
      summary: String(r.summary ?? "").slice(0, 1000),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, NEWS_MAX_RESULTS);
}

// Run one grounded news search. Returns fresh stories only (possibly empty —
// the caller/skill must treat "no fresh news" as a real answer, not retry into
// hallucination). Logs spend to usage_events (kind: news_search); when the web
// plugin is active completeChat requests exact usage.cost, so the Exa
// per-result fee is included in the logged cost, not just token pricing.
export async function searchNews(opts: {
  query: string;
  workspaceId: string;
  now?: Date; // injectable for tests
  signal?: AbortSignal;
}): Promise<{ results: NewsResult[]; searched: number }> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  // Do not combine the web plugin with forced tool output. OpenRouter currently
  // short-circuits web discovery when both are present: the model immediately
  // fills the tool with an empty list and returns zero URL citations. Let the
  // grounded web turn finish first, then normalize that evidence separately.
  const discovery = await completeChat({
    model: NEWS_MODEL,
    maxTokens: 1800,
    timeoutMs: 30_000,
    plugins: [{ id: "web", max_results: NEWS_MAX_RESULTS }],
    signal: opts.signal,
    messages: [
      {
        role: "system",
        content:
          `You are a news research assistant. Today is ${today}. ` +
          `Search the live web for timely developments about the user's topic within the last ${NEWS_MAX_AGE_DAYS} days. ` +
          `For ongoing events, include current results, live updates, today's schedule, upcoming fixtures, previews, and newly confirmed developments, not only breaking announcements. ` +
          `Return up to ${NEWS_MAX_RESULTS} candidates with title, full URL, publication or last-updated date, source, and a factual summary. ` +
          `Only report stories you actually found in the search results — never invent or fill from memory. ` +
          `Prefer primary or established sources. If nothing timely exists, say so plainly.`,
      },
      {
        role: "user",
        content:
          `Topic: ${opts.query.slice(0, 500)}\n` +
          `Today: ${today}\n` +
          `Search specifically for the latest coverage, results, schedules, announcements, and developments relevant right now.`,
      },
    ],
  });

  if (!discovery.text.trim() && !(discovery.citations?.length > 0)) {
    await logOpenRouterUsage("news_search", NEWS_MODEL, discovery.usage, opts.workspaceId, {
      query: opts.query.slice(0, 200),
    });
    return { results: [], searched: 0 };
  }

  // OpenRouter standardizes grounded sources as url_citation annotations.
  // Some providers (notably Gemini native search) keep the URLs only there,
  // while Haiku also writes them into prose. Preserve both forms so the
  // normalization stage never mistakes valid research for "no news".
  const citationEvidence = (discovery.citations ?? [])
    .map(
      (citation) =>
        `SOURCE: ${citation.title || "Untitled"}\nURL: ${citation.url}\nEXCERPT: ${citation.content}`,
    )
    .join("\n\n");
  const groundedEvidence = [discovery.text, citationEvidence]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20_000);

  const normalized = await completeChat({
    model: NEWS_MODEL,
    maxTokens: 1500,
    timeoutMs: 30_000,
    tools: [NEWS_RESULTS_TOOL],
    forceTool: "report_news_results",
    signal: opts.signal,
    messages: [
      {
        role: "system",
        content:
          `Normalize the grounded web research into structured rows. Today is ${today}. ` +
          `Use only sources and URLs present verbatim in the research. Never add a URL, fact, or date from memory. ` +
          `Use the page's publication or last-updated date as YYYY-MM-DD. Omit candidates whose date cannot be determined.`,
      },
      { role: "user", content: groundedEvidence },
    ],
  });

  await logOpenRouterUsage("news_search", NEWS_MODEL, discovery.usage, opts.workspaceId, {
    query: opts.query.slice(0, 200),
    phase: "discovery",
  });
  await logOpenRouterUsage("news_search_normalize", NEWS_MODEL, normalized.usage, opts.workspaceId, {
    query: opts.query.slice(0, 200),
    phase: "normalize",
  });

  // A structured row is still model output. Require its URL to appear in the
  // grounded discovery text before accepting it, so normalization cannot invent
  // a source that the web plugin never returned.
  const sanitized = sanitizeResults(normalized.toolArgs).filter((result) =>
    groundedEvidence.includes(result.url),
  );
  const fresh = filterFreshNews(sanitized, now);
  return { results: fresh, searched: sanitized.length };
}
