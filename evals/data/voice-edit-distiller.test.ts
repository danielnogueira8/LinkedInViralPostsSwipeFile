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

import { completeChat } from "@/lib/openrouter";
import { distillEditDeltaRules } from "@/lib/voice-edit-distiller";

function fakeSb(opts: {
  events: Array<{ id: string; before_body: string; after_body: string; created_at: string }>;
  existing: Array<{ rule: string }>;
  insertError?: boolean;
  savedResult?: { rules: string[] } | null;
  completeSucceeds?: boolean;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const sb = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "claim_draft_edit_event_batch") {
        return Promise.resolve({
          data: opts.events.map((event) => ({
            claim_token: "10000000-0000-4000-8000-000000000001",
            batch_id: "10000000-0000-4000-8000-000000000002",
            distillation_result: opts.savedResult ?? null,
            id: event.id,
            workspace_id: "ws-1",
            source_artifact_id: "art_1753000000000_0",
            saved_artifact_id: null,
            lineage_id: "30000000-0000-4000-8000-000000000001",
            before_body: event.before_body,
            after_body: event.after_body,
            edit_origin: "posts_editor",
            before_hash: "a".repeat(64),
            after_hash: "b".repeat(64),
            change_summary: {
              beforeChars: event.before_body.length,
              afterChars: event.after_body.length,
              deltaChars: event.after_body.length - event.before_body.length,
              beforeLines: 1,
              afterLines: 1,
              deltaLines: 0,
            },
            created_at: event.created_at,
          })),
          error: null,
        });
      }
      if (name === "persist_draft_edit_event_batch_result") {
        return Promise.resolve({ data: true, error: null });
      }
      if (
        name === "complete_draft_edit_event_batch"
      ) {
        return Promise.resolve({
          data: opts.completeSucceeds ?? true,
          error: null,
        });
      }
      if (name === "release_draft_edit_event_batch") {
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
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
        return {
          error: opts.insertError
            ? { message: "preference insert unavailable" }
            : null,
        };
      };
      return builder;
    },
  };
  return { sb: sb as never, inserted, rpcCalls };
}

const EVENTS = [
  {
    id: "40000000-0000-4000-8000-000000000001",
    before_body: "I would not do that.",
    after_body: "I wouldn't do that.",
    created_at: "2026-07-20T00:00:00Z",
  },
];

describe("voice edit distiller", () => {
  test("inserts distilled rules with source edit_delta", async () => {
    const { sb, inserted, rpcCalls } = fakeSb({
      events: EVENTS,
      existing: [],
    });
    const result = await distillEditDeltaRules(sb, "ws-1");
    expect(result.inserted).toBe(2);
    expect(result.skippedDuplicates).toBe(0);
    expect(inserted).toHaveLength(2);
    expect(inserted.every((row) => row.source === "edit_delta")).toBe(true);
    expect(
      rpcCalls.some(
        (call) => call.name === "persist_draft_edit_event_batch_result",
      ),
    ).toBe(true);
    expect(
      rpcCalls.some((call) => call.name === "complete_draft_edit_event_batch"),
    ).toBe(true);
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

  test("releases the cursor lease when model processing fails", async () => {
    vi.mocked(completeChat).mockRejectedValueOnce(new Error("provider down"));
    const { sb, rpcCalls } = fakeSb({ events: EVENTS, existing: [] });

    await expect(distillEditDeltaRules(sb, "ws-1")).resolves.toEqual({
      inserted: 0,
      skippedDuplicates: 0,
      candidates: 0,
    });
    expect(
      rpcCalls.some((call) => call.name === "release_draft_edit_event_batch"),
    ).toBe(true);
    expect(
      rpcCalls.some((call) => call.name === "complete_draft_edit_event_batch"),
    ).toBe(false);
  });

  test("does not advance past a preference that failed to persist", async () => {
    const { sb, rpcCalls } = fakeSb({
      events: EVENTS,
      existing: [],
      insertError: true,
    });

    await expect(distillEditDeltaRules(sb, "ws-1")).rejects.toThrow(
      "Revision preference could not be persisted",
    );
    expect(
      rpcCalls.some((call) => call.name === "release_draft_edit_event_batch"),
    ).toBe(true);
    expect(
      rpcCalls.some((call) => call.name === "complete_draft_edit_event_batch"),
    ).toBe(false);
  });

  test("reuses the persisted batch result after completion fails", async () => {
    const first = fakeSb({
      events: EVENTS,
      existing: [],
      completeSucceeds: false,
    });
    await expect(distillEditDeltaRules(first.sb, "ws-1")).rejects.toThrow(
      "cursor could not be advanced",
    );
    expect(
      first.rpcCalls.some(
        (call) => call.name === "persist_draft_edit_event_batch_result",
      ),
    ).toBe(true);

    vi.mocked(completeChat).mockClear();
    const retry = fakeSb({
      events: EVENTS,
      existing: [{ rule: "Use contractions even in formal posts" }],
      savedResult: {
        rules: [
          "Use contractions even in formal posts",
          "Cut hedging adverbs",
        ],
      },
    });
    const result = await distillEditDeltaRules(retry.sb, "ws-1");

    expect(completeChat).not.toHaveBeenCalled();
    expect(result).toEqual({
      inserted: 1,
      skippedDuplicates: 1,
      candidates: 2,
    });
    expect(retry.inserted).toEqual([
      expect.objectContaining({ rule: "Cut hedging adverbs" }),
    ]);
    expect(
      retry.rpcCalls.some(
        (call) => call.name === "persist_draft_edit_event_batch_result",
      ),
    ).toBe(false);
  });
});
