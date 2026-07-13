import { describe, test, expect, vi, beforeEach } from "vitest";

// The weekly pattern-mining brief (viral-learning loop, PR 4). We mock the
// model call (completeChat) and the DB (supabaseAdmin) and test the sampling
// floor, the settings-KV round-trip + sanitization, the render block, and the
// per-workspace failure isolation in the orchestrator.

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn(async () => undefined);
vi.mock("@/lib/openrouter", () => ({ completeChat, logOpenRouterUsage }));

// A per-table fake supabase whose responses we set per test.
type Resp = { rows?: unknown[]; single?: unknown };
let tables: Record<string, Resp> = {};
const upserts: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const resp = tables[table] ?? {};
      const chain: Record<string, unknown> = {};
      const passthrough = () => chain;
      chain.select = passthrough;
      chain.eq = passthrough;
      chain.in = passthrough;
      chain.not = passthrough;
      chain.order = passthrough;
      chain.limit = passthrough;
      chain.upsert = (row: Record<string, unknown>) => {
        upserts.push({ table, row });
        return { then: (r: (v: { error: null }) => unknown) => r({ error: null }) };
      };
      chain.maybeSingle = async () => ({ data: resp.single ?? null, error: null });
      chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
        resolve({ data: resp.rows ?? [], error: null });
      return chain;
    },
  }),
}));

const {
  renderPatternBriefBlock,
  getPatternBrief,
  generatePatternBrief,
  PATTERN_BRIEF_KEY,
} = await import("@/lib/batch/pattern-brief");

beforeEach(() => {
  completeChat.mockReset();
  logOpenRouterUsage.mockClear();
  tables = {};
  upserts.length = 0;
});

describe("renderPatternBriefBlock", () => {
  test("empty / null brief → empty block (keeps prompt byte-identical)", () => {
    expect(renderPatternBriefBlock(null)).toBe("");
    expect(
      renderPatternBriefBlock({ brief: "   ", generatedAt: "", sampleViral: 0, sampleMediocre: 0 }),
    ).toBe("");
  });

  test("a real brief renders a WHAT'S WORKING NOW block", () => {
    const block = renderPatternBriefBlock({
      brief: "- Lead with a contrarian one-liner.\n- Keep it under 900 chars.",
      generatedAt: "2026-07-13T00:00:00Z",
      sampleViral: 10,
      sampleMediocre: 8,
    });
    expect(block).toMatch(/WHAT'S WORKING NOW/);
    expect(block).toContain("contrarian one-liner");
  });
});

describe("getPatternBrief sanitization", () => {
  test("valid stored value round-trips", async () => {
    tables.settings = {
      single: {
        value: { brief: "- Do the thing.", generatedAt: "2026-07-13T00:00:00Z", sampleViral: 6, sampleMediocre: 4 },
      },
    };
    const out = await getPatternBrief("ws-1");
    expect(out?.brief).toBe("- Do the thing.");
    expect(out?.sampleViral).toBe(6);
  });

  test("missing / junk value → null (never a half-populated brief)", async () => {
    tables.settings = { single: { value: { brief: "   " } } };
    expect(await getPatternBrief("ws-1")).toBeNull();
    tables.settings = { single: null };
    expect(await getPatternBrief("ws-1")).toBeNull();
    tables.settings = { single: { value: { notABrief: true } } };
    expect(await getPatternBrief("ws-1")).toBeNull();
  });
});

describe("generatePatternBrief", () => {
  test("too few viral posts → skipped (null), no model call, no write", async () => {
    tables.workspace_accounts = { rows: [{ account_id: "a1" }] };
    // load(true) returns only 2 viral posts — under the floor of 5.
    // Both is_viral queries hit the same `posts` table stub, so give it a small
    // set; the floor check trips on the viral count.
    tables.posts = { rows: [{ text: "one" }, { text: "two" }] };

    const out = await generatePatternBrief("ws-1");
    expect(out).toBeNull();
    expect(completeChat).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  test("enough signal → calls the model and persists the brief to settings", async () => {
    tables.workspace_accounts = { rows: [{ account_id: "a1" }] };
    tables.posts = {
      rows: Array.from({ length: 6 }, (_, i) => ({ text: `viral post ${i} body here` })),
    };
    completeChat.mockResolvedValue({
      text: "- Open with a bold claim.\n- Short paragraphs.",
      usage: { prompt_tokens: 100, completion_tokens: 40 },
      finishReason: "stop",
    });

    const out = await generatePatternBrief("ws-1");
    expect(out?.brief).toContain("bold claim");
    expect(completeChat).toHaveBeenCalledOnce();
    const write = upserts.find((u) => u.table === "settings");
    expect(write?.row.key).toBe(PATTERN_BRIEF_KEY);
    expect((write?.row.value as { brief: string }).brief).toContain("bold claim");
  });

  test("model failure → null, no throw (weekly cron must survive one bad workspace)", async () => {
    tables.workspace_accounts = { rows: [{ account_id: "a1" }] };
    tables.posts = {
      rows: Array.from({ length: 6 }, (_, i) => ({ text: `viral post ${i}` })),
    };
    completeChat.mockRejectedValue(new Error("openrouter 500"));

    const out = await generatePatternBrief("ws-1");
    expect(out).toBeNull();
    expect(upserts).toHaveLength(0);
  });

  test("no tracked accounts → skipped, no model call", async () => {
    tables.workspace_accounts = { rows: [] };
    const out = await generatePatternBrief("ws-1");
    expect(out).toBeNull();
    expect(completeChat).not.toHaveBeenCalled();
  });
});
