import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// lib/news-search — grounding for the newsjacking skill. The freshness filter
// is the safety net: a stale or undated story must never reach the agent as
// "news", no matter what the search model reports.
// ---------------------------------------------------------------------------

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn(async () => {});

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...orig, completeChat, logOpenRouterUsage };
});

const {
  filterFreshNews,
  resolveNewsModel,
  searchNews,
  NEWS_MAX_RESULTS,
} = await import("@/lib/news-search");

const NOW = new Date("2026-07-11T12:00:00Z");

function story(published_at: string, title = "A story"): {
  title: string;
  url: string;
  source: string;
  published_at: string;
  summary: string;
} {
  return { title, url: "https://news.example/x", source: "Example", published_at, summary: "s" };
}

describe("filterFreshNews", () => {
  test("keeps a story from yesterday, drops one from 15 days ago", () => {
    const out = filterFreshNews([story("2026-07-10"), story("2026-06-26")], NOW, 14);
    expect(out).toHaveLength(1);
    expect(out[0].published_at).toBe("2026-07-10");
  });

  test("boundary: exactly 14 days old is kept", () => {
    // 2026-06-27T12:00:00Z is exactly 14*24h before NOW.
    const out = filterFreshNews([story("2026-06-27T12:00:00Z")], NOW, 14);
    expect(out).toHaveLength(1);
  });

  test("missing or unparseable date fails closed (dropped)", () => {
    const undated = { ...story("2026-07-10"), published_at: "" };
    const junk = { ...story("2026-07-10"), published_at: "recently" };
    expect(filterFreshNews([undated, junk], NOW, 14)).toHaveLength(0);
  });

  test("far-future date is dropped; 1-day timezone skew tolerated", () => {
    expect(filterFreshNews([story("2026-08-01")], NOW, 14)).toHaveLength(0);
    expect(filterFreshNews([story("2026-07-12")], NOW, 14)).toHaveLength(1);
  });

  test("story missing url or title is dropped", () => {
    const noUrl = { ...story("2026-07-10"), url: "" };
    expect(filterFreshNews([noUrl], NOW, 14)).toHaveLength(0);
  });
});

describe("searchNews", () => {
  beforeEach(() => {
    completeChat.mockReset();
    logOpenRouterUsage.mockClear();
  });

  test("finishes grounded web discovery before structured normalization", async () => {
    completeChat.mockResolvedValueOnce({
      text: "Fresh https://news.example/x\nStale https://news.example/stale\nUndated https://news.example/undated",
      finishReason: "stop",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolArgs: null,
    }).mockResolvedValueOnce({
      text: "",
      finishReason: "tool_calls",
      usage: { prompt_tokens: 40, completion_tokens: 20 },
      toolArgs: {
        results: [
          story("2026-07-09", "Fresh"),
          { ...story("2026-05-01", "Stale"), url: "https://news.example/stale" },
          { ...story("2026-07-08", "Undated"), url: "https://news.example/undated", published_at: "" },
        ],
      },
    });

    const { results, searched } = await searchNews({
      query: "OpenAI announcement",
      workspaceId: "ws1",
      now: NOW,
    });

    expect(searched).toBe(3);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Fresh");

    const discovery = completeChat.mock.calls[0][0];
    const normalization = completeChat.mock.calls[1][0];
    expect(discovery.plugins).toEqual([{ id: "web", max_results: NEWS_MAX_RESULTS }]);
    expect(discovery.forceTool).toBeUndefined();
    expect(discovery.tools).toBeUndefined();
    expect(normalization.plugins).toBeUndefined();
    expect(normalization.forceTool).toBe("report_news_results");
    // The prompt names today's date and the 14-day window.
    expect(discovery.messages[0].content).toContain("2026-07-11");
    expect(discovery.messages[0].content).toContain("14 days");
    expect(discovery.messages[0].content).toContain("today's schedule");
  });

  test("defaults discovery and normalization to Gemini Flash Lite", async () => {
    completeChat.mockResolvedValueOnce({ text: "No results", toolArgs: null })
      .mockResolvedValueOnce({ text: "", toolArgs: { results: [] } });
    await searchNews({ query: "any topic", workspaceId: "ws1", now: NOW });
    expect(completeChat.mock.calls[0][0].model).toBe("google/gemini-3.1-flash-lite");
    expect(completeChat.mock.calls[1][0].model).toBe("google/gemini-3.1-flash-lite");
  });

  test("OPENROUTER_NEWS_MODEL overrides the default", () => {
    expect(resolveNewsModel({ OPENROUTER_NEWS_MODEL: "anthropic/claude-haiku-4.5" })).toBe(
      "anthropic/claude-haiku-4.5",
    );
    expect(resolveNewsModel({ OPENROUTER_NEWS_MODEL: "  " })).toBe(
      "google/gemini-3.1-flash-lite",
    );
    expect(resolveNewsModel({ OPENROUTER_NEWS_MODEL: "some/unpriced-model" })).toBe(
      "google/gemini-3.1-flash-lite",
    );
  });

  test("logs spend to usage_events with kind news_search", async () => {
    completeChat.mockResolvedValueOnce({ text: "No results", usage: { prompt_tokens: 10, completion_tokens: 5 }, toolArgs: null })
      .mockResolvedValueOnce({ text: "", usage: { prompt_tokens: 4, completion_tokens: 2 }, toolArgs: { results: [] } });
    await searchNews({ query: "q", workspaceId: "ws1", now: NOW });
    expect(logOpenRouterUsage).toHaveBeenCalledTimes(2);
    expect(logOpenRouterUsage.mock.calls[0][0]).toBe("news_search");
    expect(logOpenRouterUsage.mock.calls[0][3]).toBe("ws1");
    expect(logOpenRouterUsage.mock.calls[1][0]).toBe("news_search_normalize");
    expect(logOpenRouterUsage.mock.calls[1][3]).toBe("ws1");
  });

  test("empty web discovery → empty results without a normalization call", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "stop",
      usage: undefined,
      toolArgs: null,
    });
    const { results, searched } = await searchNews({ query: "q", workspaceId: "ws1", now: NOW });
    expect(results).toEqual([]);
    expect(searched).toBe(0);
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  test("caps results at NEWS_MAX_RESULTS even if the model over-reports", async () => {
    completeChat.mockResolvedValueOnce({ text: "https://news.example/x", toolArgs: null })
      .mockResolvedValueOnce({
        text: "",
        finishReason: "tool_calls",
        usage: undefined,
        toolArgs: { results: Array.from({ length: 12 }, (_, i) => story("2026-07-10", `S${i}`)) },
      });
    const { results } = await searchNews({ query: "q", workspaceId: "ws1", now: NOW });
    expect(results.length).toBeLessThanOrEqual(NEWS_MAX_RESULTS);
  });

  test("drops a normalized URL that was not present in grounded research", async () => {
    completeChat.mockResolvedValueOnce({
      text: "Grounded source: https://news.example/real",
      toolArgs: null,
    }).mockResolvedValueOnce({
      text: "",
      toolArgs: { results: [story("2026-07-10")] },
    });
    const { results, searched } = await searchNews({ query: "q", workspaceId: "ws1", now: NOW });
    expect(results).toEqual([]);
    expect(searched).toBe(0);
  });
});
