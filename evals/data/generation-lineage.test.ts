import { describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Artifact } from "@/lib/agent/contracts";
import {
  recordSavedDraftLineage,
  tagArtifactWithGenerationLineage,
} from "@/lib/content-learning/generation-lineage";
import type { DraftRecord } from "@/lib/draft-lifecycle";

const userMessageId = "11111111-1111-4111-8111-111111111111";
const chatId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-07-26T10:00:00.000Z";

const seed = {
  schemaVersion: 1 as const,
  sourceArtifactId: "source-artifact-1",
  userMessageId,
  coworkCommand: "create" as const,
  parentArtifactId: null,
  modelSourceId: null,
  contentTemplateId: null,
  creatorStyleId: null,
  customSkillIds: ["anti-ai"],
  leadMagnetId: null,
  voiceProfileRevision: null,
  generationModel: "openai/gpt-5.6-luna",
  generatedAt: timestamp,
};

function draft(meta: Record<string, unknown> | null): DraftRecord {
  return {
    id: artifactId,
    title: "Founder-led systems",
    body: "A draft.",
    meta,
    kind: "post",
    status: "drafting",
    planToPostOn: null,
    chatId,
    createdAt: timestamp,
    mediaAttachments: [],
    scheduledAt: null,
    scheduleStatus: null,
    firstComment: null,
    publishedAt: null,
    publishError: null,
    lifecycleVersion: 0,
  };
}

describe("generation lineage dual-write", () => {
  test("stamps generated Draft artifacts but never cite artifacts", () => {
    const post = tagArtifactWithGenerationLineage(
      {
        id: "draft-1",
        kind: "post",
        title: "Draft",
        body: "Body",
        meta: { existing: true },
      },
      seed,
    );
    expect(post.meta).toMatchObject({
      existing: true,
      content_lineage: seed,
    });

    const cite: Artifact = {
      id: "cite-1",
      kind: "cite",
      title: "Source",
      body: "Source",
    };
    expect(tagArtifactWithGenerationLineage(cite, seed)).toBe(cite);
  });

  test("records exact direction and trusted agent origin after an edited Draft save", async () => {
    const maybeSingle = vi.fn(async () => ({
      data: {
        id: userMessageId,
        chat_id: chatId,
        content: "Write about founder-led systems.",
        created_at: timestamp,
      },
      error: null,
    }));
    const eqRole = vi.fn(() => ({ maybeSingle }));
    const eqWorkspace = vi.fn(() => ({ eq: eqRole }));
    const eqChat = vi.fn(() => ({ eq: eqWorkspace }));
    const eqId = vi.fn(() => ({ eq: eqChat }));
    const lineageMaybeSingle = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: {
          id: "44444444-4444-4444-8444-444444444444",
          schema_version: 1,
          workspace_id: "workspace-1",
          artifact_id: artifactId,
          parent_artifact_id: null,
          cowork_command: "create",
          cowork_chat_id: chatId,
          cowork_user_message_id: userMessageId,
          user_direction: "Write about founder-led systems.",
          inputs: {
            modelSourceId: null,
            contentTemplateId: null,
            creatorStyleId: null,
            customSkillIds: ["anti-ai"],
            leadMagnetId: null,
            voiceProfileRevision: null,
          },
          origin: {
            kind: "agent_opportunity",
            weekPlanItemId: null,
            opportunityId: "55555555-5555-4555-8555-555555555555",
          },
          generation_model: seed.generationModel,
          generated_at: timestamp,
          descriptor: {
            topic: "Founder-led systems",
            hookType: null,
            structure: null,
            ctaType: null,
          },
          created_at: timestamp,
        },
        error: null,
      });
    const lineageEqArtifact = vi.fn(() => ({
      maybeSingle: lineageMaybeSingle,
    }));
    const lineageEqWorkspace = vi.fn(() => ({ eq: lineageEqArtifact }));
    const selectLineage = vi.fn(() => ({ eq: lineageEqWorkspace }));
    const upsert = vi.fn(async () => ({ error: null }));

    const assistantOrder = vi.fn(async () => ({
      data: [
        {
          artifacts: [
            {
              body: "The original generated draft.",
              meta: { content_lineage: seed },
            },
          ],
        },
      ],
      error: null,
    }));
    const assistantContains = vi.fn(() => ({ order: assistantOrder }));
    const assistantNot = vi.fn(() => ({ contains: assistantContains }));
    const assistantEqRole = vi.fn(() => ({ not: assistantNot }));
    const assistantEqWorkspace = vi.fn(() => ({ eq: assistantEqRole }));
    const assistantEqChat = vi.fn(() => ({ eq: assistantEqWorkspace }));
    const selectMessages = vi.fn((columns: string) =>
      columns === "artifacts"
        ? { eq: assistantEqChat }
        : { eq: eqId },
    );

    const from = vi.fn((table: string) =>
      table === "chat_messages"
        ? { select: selectMessages }
        : { select: selectLineage, upsert },
    );
    await recordSavedDraftLineage(
      { from } as unknown as SupabaseClient,
      "workspace-1",
      {
        ...draft({
          content_lineage: seed,
          // Public metadata is not a trusted origin source.
          agent_opportunity_id: "66666666-6666-4666-8666-666666666666",
        }),
        body: "A user-edited draft.",
      },
      {
        opportunityId: "55555555-5555-4555-8555-555555555555",
      },
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "workspace-1",
        artifact_id: artifactId,
        user_direction: "Write about founder-led systems.",
        generation_model: seed.generationModel,
        origin: expect.objectContaining({ kind: "agent_opportunity" }),
      }),
      expect.anything(),
    );
    expect(selectMessages).toHaveBeenCalledWith("artifacts");
  });

  test("ignores client lineage metadata that is absent from server artifacts", async () => {
    const userMaybeSingle = vi.fn(async () => ({
      data: {
        id: userMessageId,
        chat_id: chatId,
        content: "Write the post.",
        created_at: timestamp,
      },
      error: null,
    }));
    const userEqRole = vi.fn(() => ({ maybeSingle: userMaybeSingle }));
    const userEqWorkspace = vi.fn(() => ({ eq: userEqRole }));
    const userEqChat = vi.fn(() => ({ eq: userEqWorkspace }));
    const userEqId = vi.fn(() => ({ eq: userEqChat }));
    const assistantOrder = vi.fn(async () => ({ data: [], error: null }));
    const assistantContains = vi.fn(() => ({ order: assistantOrder }));
    const assistantNot = vi.fn(() => ({ contains: assistantContains }));
    const assistantEqRole = vi.fn(() => ({ not: assistantNot }));
    const assistantEqWorkspace = vi.fn(() => ({ eq: assistantEqRole }));
    const assistantEqChat = vi.fn(() => ({ eq: assistantEqWorkspace }));
    const select = vi.fn((columns: string) =>
      columns === "artifacts"
        ? { eq: assistantEqChat }
        : { eq: userEqId },
    );
    const upsert = vi.fn();
    const from = vi.fn((table: string) =>
      table === "chat_messages" ? { select } : { upsert },
    );

    await recordSavedDraftLineage(
      { from } as unknown as SupabaseClient,
      "workspace-1",
      draft({ content_lineage: seed }),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  test("keeps Draft save fail-open when lineage has no valid seed", async () => {
    const from = vi.fn();
    await expect(
      recordSavedDraftLineage(
        { from } as unknown as SupabaseClient,
        "workspace-1",
        draft(null),
      ),
    ).resolves.toBeUndefined();
    expect(from).not.toHaveBeenCalled();
  });
});
