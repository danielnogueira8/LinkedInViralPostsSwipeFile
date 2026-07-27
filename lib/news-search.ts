import {
  completeChat,
  logOpenRouterUsage,
  UsagePersistenceError,
  type ToolDef,
} from "@/lib/openrouter";
import {
  coworkAdapterHealth,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import {
  providerModelAttribution,
  runCoworkAdapterAttempt,
} from "@/lib/agent/cowork-adapter-attempt";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import {
  FALLBACK_NEWS_MODEL,
  PRIMARY_NEWS_MODEL,
} from "@/lib/agent/model-config";

export {
  DEFAULT_NEWS_MODEL,
  FALLBACK_NEWS_MODEL,
  PRIMARY_NEWS_MODEL,
  resolveNewsModel,
} from "@/lib/agent/model-config";

// ---------------------------------------------------------------------------
// News search for newsjacking. The newsjacking skill needs REAL, RECENT news —
// the chat model's training data is stale and it happily hallucinates
// "announcements". This module grounds it: one bounded OpenRouter web-discovery
// attempt (Exa-backed), with one cross-model fallback when needed, followed by
// a separate structured normalization call,
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

// News search is a grounded-discovery + structured-normalization pipeline that
// relies on OpenRouter's NATIVE web search, which only a
// FEW models support well (SUPPORTED_NEWS_MODELS — models that return normal
// URLs the pipeline can preserve). So news can't follow OPENROUTER_CHAT_MODEL
// unconditionally like the rest of the app: if the app-wide chat model is one of
// the supported models, news uses it too (unified); otherwise it falls back to
// this cheap, known-good default. Pin OPENROUTER_NEWS_MODEL to override.
// Three bounded calls (primary discovery, fallback discovery, normalization)
// must fit inside Cowork's route-wide deadline and still leave time to write.
// 45s, not 20s: Anthropic's web_search server tool does real search round
// trips (one per max_uses) and a 5-result discovery measures ~20-35s even
// with reasoning disabled — 20s aborted nearly every Anthropic search at the
// finish line. 2×45s discovery + normalize still fits the 120s tool budget
// (RESEARCH_TOOL_BUDGET_MS) with room to write inside the 240s route budget.
const NEWS_STAGE_TIMEOUT_MS = 45_000;
// A fallback is useful only if the route can still afford that discovery,
// normalization, and a bounded writer window after it succeeds.
const NEWS_FALLBACK_MIN_REMAINING_MS =
  NEWS_STAGE_TIMEOUT_MS * 2 + 20_000;

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
  deadlineAtMs?: number;
  telemetry?: CoworkTurnTelemetry;
  adapterHealth?: AdapterHealthRegistry;
}): Promise<{ results: NewsResult[]; searched: number }> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  // Do not combine the web plugin with forced tool output. OpenRouter currently
  // short-circuits web discovery when both are present: the model immediately
  // fills the tool with an empty list and returns zero URL citations. Let the
  // grounded web turn finish first, then normalize that evidence separately.
  const registry = opts.adapterHealth ?? coworkAdapterHealth;
  const runDiscovery = (model: string, attempt: number, fallbackReason?: string) =>
    runCoworkAdapterAttempt({
      registry,
      adapterKey: `cowork_news_discovery:${model}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          model,
          maxTokens: 1800,
          timeoutMs: NEWS_STAGE_TIMEOUT_MS,
          // Grounded discovery is search-and-summarize, not deep reasoning —
          // adaptive thinking on Sonnet pushes the round trip past the stage
          // timeout, so run this call fast.
          disableReasoning: true,
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
        }),
      validate: (response) => response,
      persistUsage: (response) => {
        const attribution = providerModelAttribution(model, response.model);
        return logOpenRouterUsage(
          "news_search",
          attribution.model,
          response.usage,
          opts.workspaceId,
          {
            phase: "discovery",
            ...attribution.metadata,
          },
        );
      },
      usage: (response) => response.usage,
      responseModel: (response) => response.model,
      telemetry: opts.telemetry,
      stage: "news_discovery",
      attempt,
      model,
      fallbackReason,
      rejectedReasonCode: "invalid_news_discovery",
    });

  let discoveryAttempt;
  let discoveryModel = PRIMARY_NEWS_MODEL;
  try {
    discoveryAttempt = await runDiscovery(PRIMARY_NEWS_MODEL, 1);
  } catch (error) {
    // The caller's signal represents cancellation or the route-wide deadline.
    // A local stage timeout leaves time for one cross-model recovery; an outer
    // abort must stop immediately instead of starting more paid work.
    const remainingMs = opts.deadlineAtMs
      ? opts.deadlineAtMs - Date.now()
      : Number.POSITIVE_INFINITY;
    if (
      opts.signal?.aborted ||
      error instanceof UsagePersistenceError ||
      remainingMs < NEWS_FALLBACK_MIN_REMAINING_MS
    ) {
      throw error;
    }
    discoveryModel = FALLBACK_NEWS_MODEL;
    discoveryAttempt = await runDiscovery(
      FALLBACK_NEWS_MODEL,
      2,
      "primary_news_discovery_failed",
    );
  }
  const discovery = discoveryAttempt.value;

  if (!discovery.text.trim() && !(discovery.citations?.length > 0)) {
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

  // Small models occasionally answer a forced tool call in prose ("Adapter
  // response validation failed" — seen live on haiku normalization). That is
  // a flake, not a real failure, so retry the normalization once before
  // giving up the whole search (which would surface as a wrong "no fresh
  // story" answer after a SUCCESSFUL discovery).
  const runNormalization = (attempt: number, fallbackReason?: string) =>
    runCoworkAdapterAttempt({
      registry,
      adapterKey: `cowork_news_normalize:${discoveryModel}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          model: discoveryModel,
          maxTokens: 1500,
          timeoutMs: NEWS_STAGE_TIMEOUT_MS,
          // Structured extraction only — no reasoning, same latency guard as
          // the discovery call above.
          disableReasoning: true,
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
        }),
      validate: (response) => {
        if (!Array.isArray(response.toolArgs?.results)) {
          throw new Error("News normalization was missing its required schema.");
        }
        return response;
      },
      persistUsage: (response) => {
        const attribution = providerModelAttribution(
          discoveryModel,
          response.model,
        );
        return logOpenRouterUsage(
            "news_search_normalize",
            attribution.model,
          response.usage,
          opts.workspaceId,
          {
            phase: "normalize",
            ...attribution.metadata,
          },
        );
      },
      usage: (response) => response.usage,
      responseModel: (response) => response.model,
      telemetry: opts.telemetry,
      stage: "news_normalize",
      attempt,
      model: discoveryModel,
      fallbackReason,
      rejectedReasonCode: "invalid_news_normalization",
    });

  let normalizationAttempt;
  try {
    normalizationAttempt = await runNormalization(1);
  } catch (error) {
    if (opts.signal?.aborted || error instanceof UsagePersistenceError) {
      throw error;
    }
    normalizationAttempt = await runNormalization(
      2,
      "primary_news_normalization_failed",
    );
  }
  const normalized = normalizationAttempt.value;

  // A structured row is still model output. Require its URL to appear in the
  // grounded discovery text before accepting it, so normalization cannot invent
  // a source that the web plugin never returned.
  const sanitized = sanitizeResults(normalized.toolArgs).filter((result) =>
    groundedEvidence.includes(result.url),
  );
  const fresh = filterFreshNews(sanitized, now);
  return { results: fresh, searched: sanitized.length };
}
