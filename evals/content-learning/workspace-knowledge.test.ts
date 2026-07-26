import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";
import {
  createWorkspaceKnowledgeStore,
  workspaceKnowledgeFromRow,
} from "@/lib/content-learning/workspace-knowledge";

const row = {
  id: "knowledge-1",
  schema_version: 1,
  workspace_id: "workspace-1",
  kind: "belief" as const,
  title: "A durable belief",
  content: { statement: "Consistency beats occasional virality.", rationale: null },
  source: "interview" as const,
  source_ref: "voice-answer-1",
  confidence: 0.9,
  verification: "verified" as const,
  last_verified_at: "2026-07-26T10:00:00.000Z",
  active: true,
  created_at: "2026-07-26T09:00:00.000Z",
  updated_at: "2026-07-26T10:00:00.000Z",
};

describe("Workspace Knowledge row validation", () => {
  test("maps valid persisted knowledge to the public contract", () => {
    expect(workspaceKnowledgeFromRow(row)).toMatchObject({
      workspaceId: "workspace-1",
      kind: "belief",
      verification: "verified",
      active: true,
    });
  });

  test("fails closed for malformed or untraceable stored knowledge", () => {
    expect(
      workspaceKnowledgeFromRow({
        ...row,
        source_ref: null,
      }),
    ).toBeNull();
    expect(
      workspaceKnowledgeFromRow({
        ...row,
        content: { statement: "" },
      }),
    ).toBeNull();
  });

  test("retrieves only verified, active items for generation context", async () => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((field: string, value: unknown) => {
        filters.push([field, value]);
        return query;
      }),
      order: vi.fn(async () => ({ data: [row], error: null })),
    };
    const db = {
      from: vi.fn(() => query),
    } as unknown as SupabaseClient;

    await expect(
      createWorkspaceKnowledgeStore(db).listActive("workspace-1"),
    ).resolves.toHaveLength(1);
    expect(filters).toEqual([
      ["workspace_id", "workspace-1"],
      ["verification", "verified"],
      ["active", true],
    ]);
  });

  test("passes the review version and Workspace to the atomic operation", async () => {
    const rpc = vi.fn(async () => ({ data: row, error: null }));
    const db = { rpc } as unknown as SupabaseClient;

    await expect(
      createWorkspaceKnowledgeStore(db).review("workspace-1", {
        itemId: "knowledge-1",
        expectedUpdatedAt: "2026-07-26T09:00:00.000Z",
        decision: "approve",
        replacement: null,
      }),
    ).resolves.toMatchObject({ verification: "verified" });
    expect(rpc).toHaveBeenCalledWith("review_workspace_knowledge_item", {
      p_workspace_id: "workspace-1",
      p_item_id: "knowledge-1",
      p_expected_updated_at: "2026-07-26T09:00:00.000Z",
      p_decision: "approve",
      p_replacement: null,
    });
  });
});
