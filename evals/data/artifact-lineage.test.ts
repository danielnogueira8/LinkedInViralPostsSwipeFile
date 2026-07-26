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
    const upsert = vi.fn(async () => ({ error: null }));
    const maybeSingle = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: row, error: null });
    const eqArtifact = vi.fn(() => ({ maybeSingle }));
    const eqWorkspace = vi.fn(() => ({ eq: eqArtifact }));
    const select = vi.fn(() => ({ eq: eqWorkspace }));
    const from = vi.fn(() => ({ upsert, select }));
    const store = createContentLineageStore(
      { from } as unknown as SupabaseClient,
    );

    await expect(store.record(input)).resolves.toMatchObject({
      id: row.id,
      artifactId: input.artifactId,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ artifact_id: input.artifactId }),
      {
        onConflict: "artifact_id",
        ignoreDuplicates: true,
      },
    );
    expect(eqWorkspace).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(eqArtifact).toHaveBeenCalledWith(
      "artifact_id",
      input.artifactId,
    );
  });

  test("returns existing lineage without revalidating deleted source rows", async () => {
    const row = storedRow();
    const upsert = vi.fn(async () => ({ error: null }));
    const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    const eqArtifact = vi.fn(() => ({ maybeSingle }));
    const eqWorkspace = vi.fn(() => ({ eq: eqArtifact }));
    const select = vi.fn(() => ({ eq: eqWorkspace }));
    const from = vi.fn(() => ({ upsert, select }));
    const store = createContentLineageStore(
      { from } as unknown as SupabaseClient,
    );

    await expect(store.record(input)).resolves.toMatchObject({
      id: row.id,
      artifactId: input.artifactId,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  test("fails open and reports storage errors without logging direction", async () => {
    const failure = vi.fn();
    const upsert = vi.fn(async () => ({
      error: new Error("database unavailable"),
    }));
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const eqArtifact = vi.fn(() => ({ maybeSingle }));
    const eqWorkspace = vi.fn(() => ({ eq: eqArtifact }));
    const select = vi.fn(() => ({ eq: eqWorkspace }));
    const from = vi.fn(() => ({ upsert, select }));
    const store = createContentLineageStore(
      { from } as unknown as SupabaseClient,
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
