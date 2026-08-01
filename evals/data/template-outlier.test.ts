import { describe, test, expect, vi, beforeEach } from "vitest";
import { decideTemplateOutlier } from "@/lib/viral";
import { TEMPLATE_BODY_MAX } from "@/lib/templates";

// ---------------------------------------------------------------------------
// Template outliers (migration-116): the pure qualification gate in
// lib/viral.ts, and the templatizeOutlierPost LLM wrapper in lib/claude.ts
// (mocked model call, real coercion path).
// ---------------------------------------------------------------------------

const completeChat = vi.fn<
  (opts: Record<string, unknown>) => Promise<unknown>
>();
const logOpenRouterUsage = vi.fn<
  (
    kind: string,
    model: string,
    usage: unknown,
    workspaceId: string,
    metadata?: unknown,
  ) => Promise<void>
>(async () => undefined);
vi.mock("@/lib/openrouter", () => ({
  BACKGROUND_MODEL: "background-model",
  REASONING_MODEL: "reasoning-model",
  completeChat,
  logOpenRouterUsage,
}));

const { templatizeOutlierPost, PLATFORM_WORKSPACE } = await import("@/lib/claude");

describe("decideTemplateOutlier", () => {
  const config = { minHistory: 20, window: 100, cutoffPct: 5 };

  test("fewer than 20 prior posts → never qualifies, however high the score", () => {
    const d = decideTemplateOutlier({
      score: 999_999,
      priorScores: Array(19).fill(1),
      config,
    });
    expect(d.qualifies).toBe(false);
    expect(d.baseline).toBeNull();
    expect(d.sampleSize).toBe(19);
  });

  test("exactly at the 95th-percentile cutoff → qualifies (>= semantics)", () => {
    // Uniform history: P95 of 20 × 100 is exactly 100.
    const d = decideTemplateOutlier({
      score: 100,
      priorScores: Array(20).fill(100),
      config,
    });
    expect(d.baseline).toBe(100);
    expect(d.sampleSize).toBe(20);
    expect(d.qualifies).toBe(true);
  });

  test("below the cutoff → does not qualify", () => {
    const d = decideTemplateOutlier({
      score: 99,
      priorScores: Array(20).fill(100),
      config,
    });
    expect(d.qualifies).toBe(false);
    expect(d.baseline).toBe(100);
  });

  test("a genuine outlier in a varied history qualifies", () => {
    // 10..200: P95 rank = 0.95 × 19 = 18.05 → 190 + 0.05 × 10 = 190.5
    const prior = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    const d = decideTemplateOutlier({ score: 500, priorScores: prior, config });
    expect(d.baseline).toBeCloseTo(190.5, 10);
    expect(d.qualifies).toBe(true);
  });

  test("windowing: only the most recent `window` scores feed the percentile", () => {
    const cfg = { minHistory: 2, window: 3, cutoffPct: 5 };
    // The window keeps only the first 3 (low) scores; the 17 later 1000s are
    // ignored, so a modest 20 clears the windowed baseline.
    const prior = [10, 10, 10, ...Array(17).fill(1000)];
    const d = decideTemplateOutlier({ score: 20, priorScores: prior, config: cfg });
    expect(d.sampleSize).toBe(3);
    expect(d.baseline).toBe(10);
    expect(d.qualifies).toBe(true);
  });
});

describe("templatizeOutlierPost", () => {
  beforeEach(() => {
    completeChat.mockReset();
    logOpenRouterUsage.mockClear();
  });

  function mockModelText(text: string) {
    completeChat.mockResolvedValue({
      text,
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "background-model",
    });
  }

  test("parses a clean JSON template and logs usage to the platform workspace", async () => {
    mockModelText(
      '{"title":"Contrarian take","category":"contrarian","body":"Everyone says {common belief}.\\n\\nI did {the opposite} and got {the result}."}',
    );
    const out = await templatizeOutlierPost("some post");
    expect(out.title).toBe("Contrarian take");
    expect(out.category).toBe("contrarian");
    expect(out.body).toContain("{common belief}");
    expect(completeChat).toHaveBeenCalledTimes(1);
    expect(completeChat.mock.calls[0][0].glmReasoning).toBeUndefined();
    expect(logOpenRouterUsage).toHaveBeenCalledTimes(1);
    expect(logOpenRouterUsage.mock.calls[0][0]).toBe("templatize_post");
    expect(logOpenRouterUsage.mock.calls[0][3]).toBe(PLATFORM_WORKSPACE);
  });

  test("tolerates a ```json code fence around the object", async () => {
    mockModelText(
      '```json\n{"title":"T","category":"story","body":"Body with {placeholder}"}\n```',
    );
    const out = await templatizeOutlierPost("post");
    expect(out.title).toBe("T");
    expect(out.category).toBe("story");
  });

  test("an unknown category falls back to other", async () => {
    mockModelText(
      '{"title":"T","category":"made_up","body":"Body with {placeholder}"}',
    );
    const out = await templatizeOutlierPost("post");
    expect(out.category).toBe("other");
  });

  test("the body is trimmed to TEMPLATE_BODY_MAX", async () => {
    const longBody = `{placeholder} ${"x".repeat(9000)}`;
    mockModelText(
      JSON.stringify({ title: "T", category: "story", body: longBody }),
    );
    const out = await templatizeOutlierPost("post");
    expect(out.body.length).toBe(TEMPLATE_BODY_MAX);
    expect(out.body).toContain("{placeholder}");
  });

  test("a body with no {placeholder} is rejected", async () => {
    mockModelText(
      '{"title":"T","category":"story","body":"A literal copy of the post — nothing to fill in."}',
    );
    await expect(templatizeOutlierPost("post")).rejects.toThrow(
      "no usable template JSON",
    );
  });

  test("an empty model response throws", async () => {
    mockModelText("   ");
    await expect(templatizeOutlierPost("post")).rejects.toThrow(
      "Empty response",
    );
  });
});
