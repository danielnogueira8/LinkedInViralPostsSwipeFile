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
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: [row], error: null })),
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
    expect(query.limit).toHaveBeenCalledWith(50);
  });

  test("scopes review items to active knowledge from one source revision family", async () => {
    const filters: Array<[string, unknown]> = [];
    const patterns: Array<[string, string]> = [];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((field: string, value: unknown) => {
        filters.push([field, value]);
        return query;
      }),
      like: vi.fn((field: string, value: string) => {
        patterns.push([field, value]);
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: [row], error: null })),
    };
    const db = {
      from: vi.fn(() => query),
    } as unknown as SupabaseClient;

    await expect(
      createWorkspaceKnowledgeStore(db).listActiveBySource(
        "workspace-1",
        "interview",
        "voice-1:interview:",
      ),
    ).resolves.toHaveLength(1);
    expect(filters).toEqual([
      ["workspace_id", "workspace-1"],
      ["source", "interview"],
      ["active", true],
    ]);
    expect(patterns).toEqual([
      ["source_ref", "voice-1:interview:%"],
    ]);
    expect(query.limit).toHaveBeenCalledWith(50);
  });

  test("replaces an interview revision through one transactional RPC", async () => {
    const proposedRow = {
      ...row,
      verification: "proposed" as const,
      last_verified_at: null,
      source_ref:
        "voice-1:interview:contrarian_belief:2026-07-26T14:00:00.000Z",
    };
    const rpc = vi.fn(async () => ({ data: [proposedRow], error: null }));
    const db = { rpc } as unknown as SupabaseClient;
    const proposal = {
      schemaVersion: 1 as const,
      workspaceId: "workspace-1",
      kind: "belief" as const,
      title: "A belief",
      content: { statement: "Consistency compounds.", rationale: null },
      source: "interview" as const,
      sourceRef: proposedRow.source_ref,
      confidence: 1,
    };

    await expect(
      createWorkspaceKnowledgeStore(db).replaceInterviewProposals(
        "workspace-1",
        "voice-1:interview:",
        [proposal],
      ),
    ).resolves.toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith(
      "replace_interview_workspace_knowledge",
      {
        p_workspace_id: "workspace-1",
        p_source_ref_prefix: "voice-1:interview:",
        p_proposals: [
          expect.objectContaining({
            schema_version: 1,
            kind: "belief",
            identity_ref: "voice-1:interview:contrarian_belief",
            source_ref: proposedRow.source_ref,
          }),
        ],
      },
    );
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

  test("archives through the versioned domain operation", async () => {
    const archivedRow = { ...row, active: false };
    const rpc = vi.fn(async () => ({ data: archivedRow, error: null }));
    const db = { rpc } as unknown as SupabaseClient;

    await expect(
      createWorkspaceKnowledgeStore(db).archive(
        "workspace-1",
        "knowledge-1",
        "2026-07-26T10:00:00.000Z",
      ),
    ).resolves.toMatchObject({ active: false });
    expect(rpc).toHaveBeenCalledWith("archive_workspace_knowledge_item", {
      p_workspace_id: "workspace-1",
      p_item_id: "knowledge-1",
      p_expected_updated_at: "2026-07-26T10:00:00.000Z",
    });
  });
});
