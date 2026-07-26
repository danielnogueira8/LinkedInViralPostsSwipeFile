import { describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  artifactLineageFromRow,
  artifactLineageInputToRow,
  createContentLineageStore,
} from "@/lib/content-learning/lineage";
import type { ArtifactLineageInput } from "@/lib/content-learning/contracts";

const timestamp = "2026-07-26T10:00:00.000Z";
const input: ArtifactLineageInput = {
  schemaVersion: 1,
  workspaceId: "workspace-1",
  artifactId: "11111111-1111-4111-8111-111111111111",
  parentArtifactId: null,
  coworkCommand: "create",
  coworkTurn: {
    chatId: "22222222-2222-4222-8222-222222222222",
    userMessageId: "33333333-3333-4333-8333-333333333333",
  },
  userDirection: "Write about why founder-led systems compound.",
  inputs: {
    modelSourceId: "source-1",
    contentTemplateId: null,
    creatorStyleId: null,
    customSkillIds: ["anti-ai"],
    leadMagnetId: null,
    voiceProfileRevision: "voice-7",
  },
  origin: {
    kind: "cowork",
    weekPlanItemId: null,
    opportunityId: null,
  },
  generationModel: "openai/gpt-5.6-luna",
  generatedAt: timestamp,
  descriptor: {
    topic: "Founder-led systems",
    hookType: "contrarian",
    structure: "problem-solution",
    ctaType: "question",
  },
};

function storedRow() {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    ...artifactLineageInputToRow(input),
    created_at: timestamp,
  };
}

describe("Artifact Lineage store", () => {
  test("maps the typed contract to the immutable storage row and back", () => {
    const row = storedRow();

    expect(row).toMatchObject({
      workspace_id: "workspace-1",
      artifact_id: input.artifactId,
      cowork_chat_id: input.coworkTurn?.chatId,
      cowork_user_message_id: input.coworkTurn?.userMessageId,
      generation_model: "openai/gpt-5.6-luna",
    });
    expect(artifactLineageFromRow(row)).toMatchObject({
      id: row.id,
      workspaceId: "workspace-1",
      artifactId: input.artifactId,
      coworkTurn: input.coworkTurn,
    });
  });

  test("records idempotently, then returns the canonical row", async () => {
    const row = storedRow();
    const rpc = vi.fn(async () => ({ data: row, error: null }));
    const store = createContentLineageStore(
      { rpc } as unknown as SupabaseClient,
    );

    await expect(store.record(input)).resolves.toMatchObject({
      id: row.id,
      artifactId: input.artifactId,
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_artifact_lineage",
      expect.objectContaining({
        p_workspace_id: "workspace-1",
        p_artifact_id: input.artifactId,
        p_user_direction: input.userDirection,
      }),
    );
  });

  test("rejects a conflicting retry instead of trusting an existing row", async () => {
    const failure = vi.fn();
    const rpc = vi.fn(async () => ({
      data: null,
      error: new Error("Artifact lineage collision"),
    }));
    const store = createContentLineageStore(
      { rpc } as unknown as SupabaseClient,
      { onFailure: failure },
    );

    await expect(store.record(input)).resolves.toBeNull();
    expect(failure).toHaveBeenCalledWith({
      operation: "record",
      error: expect.objectContaining({
        message: "Artifact lineage collision",
      }),
    });
  });

  test("fails open and reports storage errors without logging direction", async () => {
    const failure = vi.fn();
    const rpc = vi.fn(async () => ({
      data: null,
      error: new Error("database unavailable"),
    }));
    const store = createContentLineageStore(
      { rpc } as unknown as SupabaseClient,
      { onFailure: failure },
    );

    await expect(store.record(input)).resolves.toBeNull();
    expect(failure).toHaveBeenCalledWith({
      operation: "record",
      error: expect.objectContaining({ message: "database unavailable" }),
    });
    expect(JSON.stringify(failure.mock.calls)).not.toContain(
      input.userDirection,
    );
  });
});
