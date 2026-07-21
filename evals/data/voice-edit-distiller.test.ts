import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    completeChat: vi.fn(async () => ({
      text: '{"rules":["Use contractions even in formal posts","Cut hedging adverbs"]}',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      model: "test-model",
    })),
    logOpenRouterUsage: vi.fn(async () => undefined),
  };
});

import { distillEditDeltaRules } from "@/lib/voice-edit-distiller";

function fakeSb(opts: {
  events: Array<{ id: string; before_body: string; after_body: string; created_at: string }>;
  existing: Array<{ rule: string }>;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const sb = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.order = () => builder;
      builder.limit = async () => {
        if (table === "draft_edit_events") {
          return { data: opts.events, error: null };
        }
        if (table === "content_preferences") {
          return { data: opts.existing, error: null };
        }
        return { data: [], error: null };
      };
      builder.insert = (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        return { error: null };
      };
      return builder;
    },
  };
  return { sb: sb as never, inserted };
}

const EVENTS = [
  {
    id: "e1",
    before_body: "I would not do that.",
    after_body: "I wouldn't do that.",
    created_at: "2026-07-20T00:00:00Z",
  },
];

describe("voice edit distiller", () => {
  test("inserts distilled rules with source edit_delta", async () => {
    const { sb, inserted } = fakeSb({ events: EVENTS, existing: [] });
    const result = await distillEditDeltaRules(sb, "ws-1");
    expect(result.inserted).toBe(2);
    expect(result.skippedDuplicates).toBe(0);
    expect(inserted).toHaveLength(2);
    expect(inserted.every((row) => row.source === "edit_delta")).toBe(true);
  });

  test("skips rules that duplicate existing preferences", async () => {
    const { sb, inserted } = fakeSb({
      events: EVENTS,
      existing: [{ rule: "Use contractions even in formal posts" }],
    });
    const result = await distillEditDeltaRules(sb, "ws-1");
    expect(result.inserted).toBe(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].rule).toBe("Cut hedging adverbs");
  });

  test("returns empty result when there are no edit events", async () => {
    const { sb, inserted } = fakeSb({ events: [], existing: [] });
    const result = await distillEditDeltaRules(sb, "ws-1");
    expect(result).toEqual({ inserted: 0, skippedDuplicates: 0, candidates: 0 });
    expect(inserted).toHaveLength(0);
  });
});
