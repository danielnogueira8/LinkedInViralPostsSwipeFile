import { describe, expect, test } from "vitest";
import {
  artifactLineageInputSchema,
  contentOutcomeCorrectionSchema,
  contentOutcomeSchema,
  knowledgeReviewInputSchema,
  revisionEventSchema,
  workspaceKnowledgeItemSchema,
  workspaceLearningModelSchema,
} from "@/lib/content-learning/contracts";

const timestamp = "2026-07-26T08:00:00.000Z";

describe("content-learning contracts", () => {
  test("accepts a lineage-linked, enriched revision event", () => {
    const event = revisionEventSchema.parse({
      schemaVersion: 1,
      id: "revision-1",
      workspaceId: "user_workspace",
      artifactId: "artifact-1",
      savedDraftId: "saved-draft-1",
      lineageId: "lineage-1",
      beforeBody: "A longer opening.\n\nThen the point.",
      afterBody: "A sharper opening.\n\nThen the point.",
      editOrigin: "posts_editor",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      changeSummary: {
        beforeChars: 34,
        afterChars: 35,
        deltaChars: 1,
        beforeLines: 3,
        afterLines: 3,
        deltaLines: 0,
      },
      createdAt: timestamp,
    });

    expect(event.lineageId).toBe("lineage-1");
    expect(event.savedDraftId).toBe("saved-draft-1");
    expect(event.changeSummary.deltaChars).toBe(1);
  });

  test("represents unavailable historical Cowork commands explicitly", () => {
    expect(
      artifactLineageInputSchema.parse({
        schemaVersion: 1,
        workspaceId: "user_workspace",
        artifactId: "artifact-legacy",
        parentArtifactId: null,
        coworkCommand: "unknown",
        coworkTurn: null,
        userDirection: "Historical direction unavailable.",
        inputs: {
          modelSourceId: null,
          contentTemplateId: null,
          creatorStyleId: null,
          customSkillIds: [],
          leadMagnetId: null,
          voiceProfileRevision: null,
        },
        origin: {
          kind: "backfill",
          weekPlanItemId: null,
          opportunityId: null,
        },
        generationModel: "unknown",
        generatedAt: timestamp,
        descriptor: {
          topic: null,
          hookType: null,
          structure: null,
          ctaType: null,
        },
      }).coworkCommand,
    ).toBe("unknown");
  });

  test("accepts a complete, versioned Artifact lineage input", () => {
    const parsed = artifactLineageInputSchema.parse({
      schemaVersion: 1,
      workspaceId: "user_workspace",
      artifactId: "artifact-1",
      parentArtifactId: null,
      coworkCommand: "create",
      coworkTurn: {
        chatId: "chat-1",
        userMessageId: "message-1",
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
        kind: "week_plan",
        weekPlanItemId: "slot-1",
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
    });

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.inputs.modelSourceId).toBe("source-1");
    expect(parsed.origin.weekPlanItemId).toBe("slot-1");
  });

  test("rejects unversioned lineage and invalid confidence boundaries", () => {
    expect(() =>
      artifactLineageInputSchema.parse({
        schemaVersion: 2,
      }),
    ).toThrow();

    const coworkLineage = {
      schemaVersion: 1,
      workspaceId: "user_workspace",
      artifactId: "artifact-1",
      parentArtifactId: null,
      coworkCommand: "create",
      coworkTurn: null,
      userDirection: "Write a post.",
      inputs: {
        modelSourceId: null,
        contentTemplateId: null,
        creatorStyleId: null,
        customSkillIds: [],
        leadMagnetId: null,
        voiceProfileRevision: null,
      },
      origin: {
        kind: "cowork",
        weekPlanItemId: null,
        opportunityId: null,
      },
      generationModel: "openai/gpt-5.6-luna",
      generatedAt: timestamp,
      descriptor: {
        topic: null,
        hookType: null,
        structure: null,
        ctaType: null,
      },
    };
    expect(() => artifactLineageInputSchema.parse(coworkLineage)).toThrow(
      "Cowork lineage requires a Cowork Turn reference",
    );

    expect(() =>
      workspaceKnowledgeItemSchema.parse({
        schemaVersion: 1,
        id: "knowledge-1",
        workspaceId: "user_workspace",
        kind: "proof",
        title: "Pipeline generated",
        content: { claim: "$150k in pipeline" },
        source: "interview",
        sourceRef: "answer-4",
        confidence: 1.1,
        verification: "proposed",
        lastVerifiedAt: null,
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toThrow();
  });

  test("requires evidence for extracted knowledge and supports explicit review", () => {
    const proposedProof = {
      schemaVersion: 1,
      id: "knowledge-1",
      workspaceId: "user_workspace",
      kind: "proof",
      title: "Pipeline generated",
      content: {
        claim: "$150k in pipeline",
        evidence: "Reported in the Voice interview.",
      },
      source: "interview",
      sourceRef: null,
      confidence: 0.9,
      verification: "proposed",
      lastVerifiedAt: null,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;

    expect(() =>
      workspaceKnowledgeItemSchema.parse(proposedProof),
    ).toThrow("Extracted knowledge requires a source reference");

    expect(
      knowledgeReviewInputSchema.parse({
        itemId: "knowledge-1",
        expectedUpdatedAt: timestamp,
        decision: "approve",
        replacement: {
          kind: "proof",
          title: "Verified pipeline generated",
          content: {
            claim: "$150k in pipeline",
            evidence: "Confirmed by the Workspace owner.",
          },
        },
      }).decision,
    ).toBe("approve");
  });

  test("requires monetary outcomes to carry currency and normalizes it", () => {
    const base = {
      schemaVersion: 1,
      id: "outcome-1",
      workspaceId: "user_workspace",
      draftId: "draft-1",
      lineageId: "lineage-1",
      kind: "pipeline",
      source: "manual",
      externalId: null,
      idempotencyKey: "manual:outcome-1",
      status: "active",
      supersedesOutcomeId: null,
      confidence: 1,
      quantity: 1,
      occurredAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;

    expect(() =>
      contentOutcomeSchema.parse({
        ...base,
        amountMinor: 150_000,
        currency: null,
      }),
    ).toThrow("amountMinor and currency must be provided together");

    expect(
      contentOutcomeSchema.parse({
        ...base,
        amountMinor: 150_000,
        currency: "usd",
      }).currency,
    ).toBe("USD");

    expect(() =>
      contentOutcomeSchema.parse({
        ...base,
        source: "leadshark",
        amountMinor: null,
        currency: null,
      }),
    ).toThrow("Imported outcomes require an external id");

    expect(
      contentOutcomeCorrectionSchema.parse({
        outcomeId: "outcome-1",
        expectedUpdatedAt: timestamp,
        reason: "Corrected the attributed pipeline amount.",
        idempotencyKey: "correction:outcome-1:v2",
        replacement: {
          kind: "pipeline",
          confidence: 1,
          quantity: 1,
          amountMinor: 125_000,
          currency: "usd",
          occurredAt: timestamp,
        },
      }).replacement.currency,
    ).toBe("USD");
  });

  test("keeps deterministic learning evidence separate from explanations", () => {
    const parsed = workspaceLearningModelSchema.parse({
      schemaVersion: 1,
      id: "learning-1",
      workspaceId: "user_workspace",
      version: 1,
      status: "shadow",
      sourceMode: "published_posts",
      publishedPostCount: 8,
      calculationVersion: "learning-v1",
      inputFingerprint: "sha256:abc",
      signals: [
        {
          kind: "hook",
          key: "contrarian",
          label: "Contrarian hooks",
          score: 0.42,
          confidence: 0.8,
          sampleSize: 8,
          baseline: 1000,
          trend: "up",
          evidence: [
            {
              kind: "lineage",
              lineageId: "lineage-1",
              artifactId: "artifact-1",
            },
            {
              kind: "performance",
              draftId: "draft-1",
              metric: "impressions",
              value: 1800,
              observedAt: timestamp,
            },
          ],
          representativeExample: "Most advice gets this backwards.",
          explanation: "This hook is outperforming the Workspace baseline.",
          calculatedAt: timestamp,
        },
      ],
      calculatedAt: timestamp,
      createdAt: timestamp,
    });

    expect(parsed.signals[0]).toMatchObject({
      score: 0.42,
      sampleSize: 8,
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: "lineage", lineageId: "lineage-1" }),
        expect.objectContaining({ kind: "performance", value: 1800 }),
      ]),
    });
  });

  test("rejects a scored learning signal without evidence", () => {
    expect(() =>
      workspaceLearningModelSchema.parse({
        schemaVersion: 1,
        id: "learning-1",
        workspaceId: "user_workspace",
        version: 1,
        status: "shadow",
        sourceMode: "voice_exemplars",
        publishedPostCount: 0,
        calculationVersion: "learning-v1",
        inputFingerprint: "sha256:empty",
        signals: [
          {
            kind: "topic",
            key: "systems",
            label: "Systems",
            score: 0.2,
            confidence: 0.2,
            sampleSize: 0,
            baseline: null,
            trend: "unknown",
            evidence: [],
            representativeExample: null,
            explanation: null,
            calculatedAt: timestamp,
          },
        ],
        calculatedAt: timestamp,
        createdAt: timestamp,
      }),
    ).toThrow();
  });

  test("enforces the Voice-to-published cold-start boundary", () => {
    const model = {
      schemaVersion: 1,
      id: "learning-1",
      workspaceId: "user_workspace",
      version: 1,
      status: "shadow",
      sourceMode: "voice_exemplars",
      publishedPostCount: 4,
      calculationVersion: "learning-v1",
      inputFingerprint: "sha256:cold-start",
      signals: [],
      calculatedAt: timestamp,
      createdAt: timestamp,
    } as const;

    expect(workspaceLearningModelSchema.parse(model).sourceMode).toBe(
      "voice_exemplars",
    );
    expect(() =>
      workspaceLearningModelSchema.parse({
        ...model,
        publishedPostCount: 5,
      }),
    ).toThrow("sourceMode must be published_posts");
    expect(
      workspaceLearningModelSchema.parse({
        ...model,
        sourceMode: "published_posts",
        publishedPostCount: 5,
      }).sourceMode,
    ).toBe("published_posts");
  });
});
