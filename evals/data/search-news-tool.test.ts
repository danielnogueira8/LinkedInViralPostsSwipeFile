import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// The search_news agent tool — grounding for newsjacking. Wiring tests: the
// tool is registered, cost-gated, wraps external content as untrusted, and
// the newsjacking skill actually instructs the model to call it.
// ---------------------------------------------------------------------------

const searchNews = vi.fn();
const checkChatCostAllowance = vi.fn();

vi.mock("@/lib/news-search", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/news-search")>();
  return { ...orig, searchNews };
});
vi.mock("@/lib/agent/rate-limit", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/rate-limit")>();
  return { ...orig, checkChatCostAllowance };
});
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "u1" }) }));

const { TOOL_DEFS, TOOL_FNS, runTool } = await import("@/lib/agent/tools");
const { SKILLS } = await import("@/lib/agent/skills/index");

const FRESH_STORY = {
  title: "OpenAI ships a thing",
  url: "https://news.example/openai",
  source: "TechCrunch",
  published_at: "2026-07-10",
  summary: "OpenAI announced a thing. It matters.",
};

beforeEach(() => {
  searchNews.mockReset();
  checkChatCostAllowance.mockReset();
  checkChatCostAllowance.mockResolvedValue({ ok: true });
});

describe("search_news tool wiring", () => {
  test("registered in both TOOL_DEFS and TOOL_FNS", () => {
    expect(TOOL_DEFS.some((t) => t.function.name === "search_news")).toBe(true);
    expect(typeof TOOL_FNS.search_news).toBe("function");
  });

  test("empty query → error result, no search call, no spend check bypass", async () => {
    const res = await runTool("search_news", { query: "  " }, "ws1");
    expect(res.ok).toBe(false);
    expect(searchNews).not.toHaveBeenCalled();
  });

  test("over-budget workspace gets a readable refusal instead of a charge", async () => {
    checkChatCostAllowance.mockResolvedValue({
      ok: false,
      reason: "monthly",
      message: "Monthly budget reached.",
    });
    const res = await runTool("search_news", { query: "OpenAI" }, "ws1");
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("budget");
    expect(searchNews).not.toHaveBeenCalled();
  });

  test("returns fresh stories with untrusted-wrapped free text; url/date/source plain", async () => {
    searchNews.mockResolvedValue({ results: [FRESH_STORY], searched: 3 });
    const res = await runTool("search_news", { query: "OpenAI" }, "ws1");
    expect(res.ok).toBe(true);
    expect(res.searched).toBe(3);
    const results = res.results as Array<Record<string, string>>;
    expect(results).toHaveLength(1);
    // Free-text fields are wrapped as untrusted content blocks.
    expect(results[0].title).toContain("OpenAI ships a thing");
    expect(results[0].title).toContain("<news_title");
    expect(results[0].summary).toContain("<news_summary");
    // Structured fields stay plain so the model can cite them.
    expect(results[0].url).toBe(FRESH_STORY.url);
    expect(results[0].published_at).toBe("2026-07-10");
    expect(searchNews).toHaveBeenCalledWith(
      expect.objectContaining({ query: "OpenAI", workspaceId: "ws1" }),
    );
  });

  test("forwards the active turn signal into grounded news search", async () => {
    searchNews.mockResolvedValue({ results: [FRESH_STORY], searched: 1 });
    const controller = new AbortController();

    await runTool("search_news", { query: "OpenAI" }, "ws1", controller.signal);

    expect(searchNews).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  test("no fresh stories → explicit note telling the model not to invent news", async () => {
    searchNews.mockResolvedValue({ results: [], searched: 4 });
    const res = await runTool("search_news", { query: "obscure topic" }, "ws1");
    expect(res.ok).toBe(true);
    expect(String(res.note)).toMatch(/do NOT invent/i);
  });

  test("search failure → error result, not a thrown turn-abort", async () => {
    searchNews.mockRejectedValue(new Error("openrouter 500"));
    const res = await runTool("search_news", { query: "OpenAI" }, "ws1");
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("openrouter 500");
  });
});

describe("newsjacking skill grounding", () => {
  test("skill body requires calling search_news before drafting", () => {
    const news = SKILLS.find((s) => s.id === "newsjacking");
    expect(news).toBeDefined();
    expect(news!.body).toContain("search_news");
    expect(news!.body).toMatch(/BEFORE drafting/i);
    // The no-fresh-news path must be a real answer, not a fallback to stale news.
    expect(news!.body).toMatch(/never substitute an older story/i);
  });
});
