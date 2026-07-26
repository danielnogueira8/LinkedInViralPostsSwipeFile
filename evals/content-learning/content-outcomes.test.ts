import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";
import {
  buildManualOutcome,
  contentOutcomeFromRow,
  createContentOutcomesStore,
  manualOutcomeInputSchema,
} from "@/lib/content-learning/content-outcomes";

const timestamp = "2026-07-26T12:00:00.000Z";
const row = {
  id: "10000000-0000-4000-8000-000000000001",
  schema_version: 1,
  workspace_id: "workspace-1",
  draft_id: "20000000-0000-4000-8000-000000000001",
  lineage_id: null,
  kind: "booked_call" as const,
  source: "manual" as const,
  external_id: null,
  idempotency_key: "manual:draft:request",
  status: "active" as const,
  supersedes_outcome_id: null,
  confidence: 1,
  quantity: 2,
  amount_minor: null,
  currency: null,
  occurred_at: timestamp,
  created_at: timestamp,
  updated_at: timestamp,
};

describe("Content Outcomes store", () => {
  test("maps validated storage rows and rejects incomplete money", () => {
    expect(contentOutcomeFromRow(row)).toMatchObject({
      kind: "booked_call",
      quantity: 2,
    });
    expect(
      manualOutcomeInputSchema.safeParse({
        requestId: "30000000-0000-4000-8000-000000000001",
        kind: "pipeline",
        quantity: 1,
        amountMinor: 5000,
        currency: null,
        occurredAt: timestamp,
      }).success,
    ).toBe(false);
  });

  test("builds a manual outcome with a retry-stable idempotency key", () => {
    expect(
      buildManualOutcome({
        id: row.id,
        workspaceId: row.workspace_id,
        draftId: row.draft_id,
        lineageId: null,
        requestId: "30000000-0000-4000-8000-000000000001",
        kind: "lead",
        quantity: 1,
        amountMinor: null,
        currency: null,
        occurredAt: timestamp,
        now: timestamp,
      }),
    ).toMatchObject({
      source: "manual",
      confidence: 1,
      idempotencyKey:
        `manual:${row.draft_id}:30000000-0000-4000-8000-000000000001`,
    });
  });

  test("lists only active outcomes for the requested Workspace Draft", async () => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((field: string, value: unknown) => {
        filters.push([field, value]);
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: [row], error: null })),
    };
    const db = { from: vi.fn(() => query) } as unknown as SupabaseClient;
    await expect(
      createContentOutcomesStore(db).listByDraft(
        row.workspace_id,
        row.draft_id,
      ),
    ).resolves.toHaveLength(1);
    expect(filters).toEqual([
      ["workspace_id", row.workspace_id],
      ["draft_id", row.draft_id],
      ["status", "active"],
    ]);
    expect(query.limit).toHaveBeenCalledWith(100);
  });

  test("does not disguise an outcome read failure as an empty history", async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({
        data: null,
        error: new Error("database unavailable"),
      })),
    };
    const db = { from: vi.fn(() => query) } as unknown as SupabaseClient;
    await expect(
      createContentOutcomesStore(db, vi.fn()).listByDraft(
        row.workspace_id,
        row.draft_id,
      ),
    ).rejects.toThrow("database unavailable");
  });

  test("passes correction version and replacement through one atomic RPC", async () => {
    const rpc = vi.fn(async () => ({ data: row, error: null }));
    const db = { rpc } as unknown as SupabaseClient;
    await expect(
      createContentOutcomesStore(db).correct(row.workspace_id, {
        outcomeId: row.id,
        expectedUpdatedAt: timestamp,
        reason: "The call count changed.",
        idempotencyKey: "correction:request",
        replacement: {
          kind: "booked_call",
          confidence: 1,
          quantity: 2,
          amountMinor: null,
          currency: null,
          occurredAt: timestamp,
        },
      }),
    ).resolves.toMatchObject({ id: row.id });
    expect(rpc).toHaveBeenCalledWith("correct_content_outcome", {
      p_workspace_id: row.workspace_id,
      p_outcome_id: row.id,
      p_expected_updated_at: timestamp,
      p_reason: "The call count changed.",
      p_idempotency_key: "correction:request",
      p_kind: "booked_call",
      p_confidence: 1,
      p_quantity: 2,
      p_amount_minor: null,
      p_currency: null,
      p_occurred_at: timestamp,
    });
  });
});
