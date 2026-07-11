import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// lib/news-search — grounding for the newsjacking skill. The freshness filter
// is the safety net: a stale or undated story must never reach the agent as
// "news", no matter what the search model reports.
// ---------------------------------------------------------------------------

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn(async (..._args: unknown[]) => {});

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...orig, completeChat, logOpenRouterUsage };
});

const { filterFreshNews, searchNews, NEWS_MAX_RESULTS } = await import("@/lib/news-search");

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

  test("passes the web plugin, forces structured output, filters stale results", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolArgs: {
        results: [
          story("2026-07-09", "Fresh"),
          story("2026-05-01", "Stale"),
          { ...story("2026-07-08", "Undated"), published_at: "" },
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

    const call = completeChat.mock.calls[0][0];
    expect(call.plugins).toEqual([{ id: "web", max_results: NEWS_MAX_RESULTS }]);
    expect(call.forceTool).toBe("report_news_results");
    // The prompt names today's date and the 14-day window.
    expect(call.messages[0].content).toContain("2026-07-11");
    expect(call.messages[0].content).toContain("14 days");
  });

  test("runs on the reasoning-tier model (Sonnet), not the cheap GLM background tier", async () => {
    // GLM formulated weak search queries for broad/auto-picked topics and
    // reported "no relevant news" for stories dominating the headlines.
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      toolArgs: { results: [] },
    });
    await searchNews({ query: "any topic", workspaceId: "ws1", now: NOW });
    const call = completeChat.mock.calls[0][0];
    expect(call.model).toBe("anthropic/claude-sonnet-5");
    expect(call.model).not.toMatch(/glm/i);
  });

  test("logs spend to usage_events with kind news_search", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      toolArgs: { results: [] },
    });
    await searchNews({ query: "q", workspaceId: "ws1", now: NOW });
    expect(logOpenRouterUsage).toHaveBeenCalledTimes(1);
    expect(logOpenRouterUsage.mock.calls[0][0]).toBe("news_search");
    expect(logOpenRouterUsage.mock.calls[0][3]).toBe("ws1");
  });

  test("malformed tool output → empty results, no throw", async () => {
    completeChat.mockResolvedValue({
      text: "here is some prose instead",
      finishReason: "stop",
      usage: undefined,
      toolArgs: null,
    });
    const { results, searched } = await searchNews({ query: "q", workspaceId: "ws1", now: NOW });
    expect(results).toEqual([]);
    expect(searched).toBe(0);
  });

  test("caps results at NEWS_MAX_RESULTS even if the model over-reports", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      usage: undefined,
      toolArgs: { results: Array.from({ length: 12 }, (_, i) => story("2026-07-10", `S${i}`)) },
    });
    const { results } = await searchNews({ query: "q", workspaceId: "ws1", now: NOW });
    expect(results.length).toBeLessThanOrEqual(NEWS_MAX_RESULTS);
  });
});
