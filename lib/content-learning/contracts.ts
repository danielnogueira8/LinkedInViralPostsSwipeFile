import { z } from "zod";

export const CONTENT_LEARNING_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().trim().min(1).max(160);
const nullableIdSchema = idSchema.nullable();
const workspaceIdSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.string().datetime({ offset: true });
const shortTextSchema = z.string().trim().min(1).max(240);

export const contentOriginSchema = z.enum([
  "cowork",
  "week_plan",
  "agent_opportunity",
  "mcp",
  "api",
  "backfill",
  "unknown",
]);
export type ContentOrigin = z.infer<typeof contentOriginSchema>;

export const contentDescriptorSchema = z
  .object({
    topic: z.string().trim().min(1).max(240).nullable(),
    hookType: z.string().trim().min(1).max(120).nullable(),
    structure: z.string().trim().min(1).max(120).nullable(),
    ctaType: z.string().trim().min(1).max(120).nullable(),
  })
  .strict();
export type ContentDescriptor = z.infer<typeof contentDescriptorSchema>;

export const explorationLaneSchema = z.enum([
  "familiar",
  "fresh",
  "experimental",
]);
export type ExplorationLane = z.infer<typeof explorationLaneSchema>;

export const contentLineageInputsSchema = z
  .object({
    modelSourceId: nullableIdSchema,
    contentTemplateId: nullableIdSchema,
    creatorStyleId: nullableIdSchema,
    customSkillIds: z.array(idSchema).max(20),
    leadMagnetId: nullableIdSchema,
    voiceProfileRevision: nullableIdSchema,
    explorationLane: explorationLaneSchema.nullable().optional(),
    knowledgeSources: z
      .array(
        z
          .object({
            sourceId: idSchema,
            sourceRevisionId: idSchema,
            chunkIds: z.array(idSchema).max(6),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type ContentLineageInputs = z.infer<
  typeof contentLineageInputsSchema
>;

export const contentLineageOriginSchema = z
  .object({
    kind: contentOriginSchema,
    weekPlanItemId: nullableIdSchema,
    opportunityId: nullableIdSchema,
  })
  .strict();
export type ContentLineageOrigin = z.infer<
  typeof contentLineageOriginSchema
>;

export const coworkTurnReferenceSchema = z
  .object({
    chatId: idSchema,
    userMessageId: idSchema,
  })
  .strict();
export type CoworkTurnReference = z.infer<
  typeof coworkTurnReferenceSchema
>;

export const artifactLineageInputSchema = z
  .object({
    schemaVersion: z.literal(CONTENT_LEARNING_SCHEMA_VERSION),
    workspaceId: workspaceIdSchema,
    artifactId: idSchema,
    parentArtifactId: nullableIdSchema,
    coworkCommand: z.enum(["ask", "create", "edit", "unknown"]),
    coworkTurn: coworkTurnReferenceSchema.nullable(),
    userDirection: z.string().trim().min(1).max(12_000),
    inputs: contentLineageInputsSchema,
    origin: contentLineageOriginSchema,
    generationModel: z.string().trim().min(1).max(200),
    generatedAt: timestampSchema,
    descriptor: contentDescriptorSchema,
  })
  .strict()
  .superRefine((lineage, context) => {
    if (lineage.origin.kind === "cowork" && lineage.coworkTurn === null) {
      context.addIssue({
        code: "custom",
        message: "Cowork lineage requires a Cowork Turn reference",
        path: ["coworkTurn"],
      });
    }
  });
export type ArtifactLineageInput = z.infer<
  typeof artifactLineageInputSchema
>;

export const artifactLineageSchema = artifactLineageInputSchema
  .safeExtend({
    id: idSchema,
    createdAt: timestampSchema,
  })
  .strict();
export type ArtifactLineage = z.infer<typeof artifactLineageSchema>;

export const revisionEditOriginSchema = z.enum([
  "cowork_artifact",
  "posts_editor",
  "unknown",
]);
export type RevisionEditOrigin = z.infer<typeof revisionEditOriginSchema>;

export const revisionChangeSummarySchema = z
  .object({
    beforeChars: z.number().int().nonnegative(),
    afterChars: z.number().int().nonnegative(),
    deltaChars: z.number().int(),
    beforeLines: z.number().int().nonnegative(),
    afterLines: z.number().int().nonnegative(),
    deltaLines: z.number().int(),
  })
  .strict();
export type RevisionChangeSummary = z.infer<
  typeof revisionChangeSummarySchema
>;

export const revisionEventSchema = z
  .object({
    schemaVersion: z.literal(CONTENT_LEARNING_SCHEMA_VERSION),
    id: idSchema,
    workspaceId: workspaceIdSchema,
    artifactId: idSchema,
    savedDraftId: nullableIdSchema,
    lineageId: nullableIdSchema,
    beforeBody: z.string(),
    afterBody: z.string(),
    editOrigin: revisionEditOriginSchema,
    beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
    afterHash: z.string().regex(/^[0-9a-f]{64}$/),
    changeSummary: revisionChangeSummarySchema,
    createdAt: timestampSchema,
  })
  .strict();
export type RevisionEvent = z.infer<typeof revisionEventSchema>;

export const KNOWLEDGE_ITEM_KINDS = [
  "story",
  "belief",
  "proof",
  "offer",
  "audience_insight",
  "topic_expertise",
  "prohibition",
] as const;
export const knowledgeItemKindSchema = z.enum(KNOWLEDGE_ITEM_KINDS);
export type KnowledgeItemKind = z.infer<typeof knowledgeItemKindSchema>;

export const knowledgeItemSourceSchema = z.enum([
  "manual",
  "interview",
  "voice_profile",
  "published_post",
  "cowork",
  "knowledge_source",
]);
export type KnowledgeItemSource = z.infer<
  typeof knowledgeItemSourceSchema
>;

export const knowledgeVerificationSchema = z.enum([
  "proposed",
  "verified",
  "rejected",
]);
export type KnowledgeVerification = z.infer<
  typeof knowledgeVerificationSchema
>;

const knowledgeItemBaseShape = {
  schemaVersion: z.literal(CONTENT_LEARNING_SCHEMA_VERSION),
  id: idSchema,
  workspaceId: workspaceIdSchema,
  title: shortTextSchema,
  source: knowledgeItemSourceSchema,
  sourceRef: nullableIdSchema,
  confidence: z.number().min(0).max(1),
  verification: knowledgeVerificationSchema,
  lastVerifiedAt: timestampSchema.nullable(),
  active: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

const storyContentSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    details: z.string().trim().min(1).max(12_000).nullable(),
  })
  .strict();
const beliefContentSchema = z
  .object({
    statement: z.string().trim().min(1).max(2_000),
    rationale: z.string().trim().min(1).max(6_000).nullable(),
  })
  .strict();
const proofContentSchema = z
  .object({
    claim: z.string().trim().min(1).max(2_000),
    evidence: z.string().trim().min(1).max(6_000).nullable(),
  })
  .strict();
const offerContentSchema = z
  .object({
    name: shortTextSchema,
    promise: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();
const audienceInsightContentSchema = z
  .object({
    audience: shortTextSchema,
    insight: z.string().trim().min(1).max(2_000),
  })
  .strict();
const topicExpertiseContentSchema = z
  .object({
    topic: shortTextSchema,
    basis: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();
const prohibitionContentSchema = z
  .object({
    claim: z.string().trim().min(1).max(2_000),
    reason: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();

const knowledgeContentSchemas = {
  story: storyContentSchema,
  belief: beliefContentSchema,
  proof: proofContentSchema,
  offer: offerContentSchema,
  audience_insight: audienceInsightContentSchema,
  topic_expertise: topicExpertiseContentSchema,
  prohibition: prohibitionContentSchema,
} satisfies Record<KnowledgeItemKind, z.ZodType>;

const knowledgeItemSchemas = KNOWLEDGE_ITEM_KINDS.map((kind) =>
  z
    .object({
      ...knowledgeItemBaseShape,
      kind: z.literal(kind),
      content: knowledgeContentSchemas[kind],
    })
    .strict(),
);

function asNonEmptySchemaTuple<Schema extends z.ZodType>(
  schemas: Schema[],
): [Schema, ...Schema[]] {
  if (schemas.length === 0) {
    throw new Error("At least one Knowledge schema is required");
  }
  return schemas as [Schema, ...Schema[]];
}

export const workspaceKnowledgeItemSchema = z
  .union(asNonEmptySchemaTuple(knowledgeItemSchemas))
  .superRefine((item, context) => {
    if (item.source !== "manual" && item.sourceRef === null) {
      context.addIssue({
        code: "custom",
        message: "Extracted knowledge requires a source reference",
        path: ["sourceRef"],
      });
    }
  });
export type WorkspaceKnowledgeItem = z.infer<
  typeof workspaceKnowledgeItemSchema
>;

const knowledgeItemRevisionSchemas = KNOWLEDGE_ITEM_KINDS.map((kind) =>
  z
    .object({
      kind: z.literal(kind),
      title: shortTextSchema,
      content: knowledgeContentSchemas[kind],
    })
    .strict(),
);
export const knowledgeItemRevisionSchema = z.union(
  asNonEmptySchemaTuple(knowledgeItemRevisionSchemas),
);
export type KnowledgeItemRevision = z.infer<
  typeof knowledgeItemRevisionSchema
>;

export const knowledgeReviewInputSchema = z
  .object({
    itemId: idSchema,
    expectedUpdatedAt: timestampSchema,
    decision: z.enum(["approve", "reject"]),
    replacement: knowledgeItemRevisionSchema.nullable(),
  })
  .strict();
export type KnowledgeReviewInput = z.infer<
  typeof knowledgeReviewInputSchema
>;

type DistributiveOmit<T, Keys extends PropertyKey> = T extends unknown
  ? Omit<T, Keys>
  : never;
export type WorkspaceKnowledgeProposal = DistributiveOmit<
  WorkspaceKnowledgeItem,
  | "id"
  | "verification"
  | "lastVerifiedAt"
  | "active"
  | "createdAt"
  | "updatedAt"
>;

const workspaceKnowledgeProposalSchemas = KNOWLEDGE_ITEM_KINDS.map((kind) =>
  z
    .object({
      schemaVersion: z.literal(CONTENT_LEARNING_SCHEMA_VERSION),
      workspaceId: workspaceIdSchema,
      kind: z.literal(kind),
      title: shortTextSchema,
      content: knowledgeContentSchemas[kind],
      source: knowledgeItemSourceSchema,
      sourceRef: nullableIdSchema,
      confidence: z.number().min(0).max(1),
    })
    .strict(),
);
export const workspaceKnowledgeProposalSchema = z
  .union(asNonEmptySchemaTuple(workspaceKnowledgeProposalSchemas))
  .superRefine((proposal, context) => {
    if (proposal.source !== "manual" && proposal.sourceRef === null) {
      context.addIssue({
        code: "custom",
        message: "Extracted knowledge requires a source reference",
        path: ["sourceRef"],
      });
    }
  });

export const contentOutcomeKindSchema = z.enum([
  "qualified_conversation",
  "qualified_dm",
  "lead_magnet_conversion",
  "lead",
  "booked_call",
  "pipeline",
  "revenue",
]);
export type ContentOutcomeKind = z.infer<typeof contentOutcomeKindSchema>;

export const contentOutcomeSourceSchema = z.enum([
  "manual",
  "leadshark",
]);
export type ContentOutcomeSource = z.infer<
  typeof contentOutcomeSourceSchema
>;

const monetaryAmountShape = {
  amountMinor: z.number().int().min(0).nullable(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase())
    .nullable(),
};

function validateMonetaryAmount(
  value: { amountMinor: number | null; currency: string | null },
  context: z.RefinementCtx,
  pathPrefix: PropertyKey[] = [],
): void {
  const hasMoney = value.amountMinor !== null;
  const hasCurrency = value.currency !== null;
  if (hasMoney === hasCurrency) return;
  context.addIssue({
    code: "custom",
    message: "amountMinor and currency must be provided together",
    path: [...pathPrefix, hasMoney ? "currency" : "amountMinor"],
  });
}

export const contentOutcomeSchema = z
  .object({
    schemaVersion: z.literal(CONTENT_LEARNING_SCHEMA_VERSION),
    id: idSchema,
    workspaceId: workspaceIdSchema,
    draftId: idSchema,
    lineageId: nullableIdSchema,
    kind: contentOutcomeKindSchema,
    source: contentOutcomeSourceSchema,
    externalId: nullableIdSchema,
    idempotencyKey: idSchema,
    status: z.enum(["active", "superseded"]),
    supersedesOutcomeId: nullableIdSchema,
    confidence: z.number().min(0).max(1),
    quantity: z.number().int().min(1),
    ...monetaryAmountShape,
    occurredAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((outcome, context) => {
    validateMonetaryAmount(outcome, context);
    if (outcome.source === "leadshark" && outcome.externalId === null) {
      context.addIssue({
        code: "custom",
        message: "Imported outcomes require an external id",
        path: ["externalId"],
      });
    }
  });
export type ContentOutcome = z.infer<typeof contentOutcomeSchema>;

export const contentOutcomeCorrectionSchema = z
  .object({
    outcomeId: idSchema,
    expectedUpdatedAt: timestampSchema,
    reason: z.string().trim().min(1).max(1_000),
    idempotencyKey: idSchema,
    replacement: z
      .object({
        kind: contentOutcomeKindSchema,
        confidence: z.number().min(0).max(1),
        quantity: z.number().int().min(1),
        ...monetaryAmountShape,
        occurredAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((correction, context) => {
    validateMonetaryAmount(correction.replacement, context, ["replacement"]);
  });
export type ContentOutcomeCorrection = z.infer<
  typeof contentOutcomeCorrectionSchema
>;

export const learningSignalKindSchema = z.enum([
  "topic",
  "hook",
  "format",
  "cta",
  "source_pattern",
  "voice_preference",
]);
export type LearningSignalKind = z.infer<
  typeof learningSignalKindSchema
>;

export const learningEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("voice_exemplar"),
      voiceProfileId: idSchema,
      exemplarIndex: z.number().int().nonnegative(),
      generatedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("lineage"),
      lineageId: idSchema,
      artifactId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("revision"),
      revisionEventId: idSchema,
      artifactId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("publication"),
      draftId: idSchema,
      publishedAt: timestampSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("performance"),
      draftId: idSchema,
      metric: z.enum([
        "impressions",
        "likes",
        "comments",
        "reposts",
        "followers",
      ]),
      value: z.number().finite(),
      observedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("outcome"),
      outcomeId: idSchema,
    })
    .strict(),
]);
export type LearningEvidence = z.infer<typeof learningEvidenceSchema>;

export const learningSignalSchema = z
  .object({
    kind: learningSignalKindSchema,
    key: shortTextSchema,
    label: shortTextSchema,
    score: z.number().min(-1).max(1),
    confidence: z.number().min(0).max(1),
    sampleSize: z.number().int().positive(),
    baseline: z.number().finite().nullable(),
    trend: z.enum(["up", "flat", "down", "unknown"]),
    evidence: z.array(learningEvidenceSchema).min(1).max(200),
    representativeExample: z.string().trim().min(1).max(2_000).nullable(),
    explanation: z.string().trim().min(1).max(2_000).nullable(),
    calculatedAt: timestampSchema,
  })
  .strict();
export type LearningSignal = z.infer<typeof learningSignalSchema>;

export const workspaceLearningModelSchema = z
  .object({
    schemaVersion: z.literal(CONTENT_LEARNING_SCHEMA_VERSION),
    id: idSchema,
    workspaceId: workspaceIdSchema,
    version: z.number().int().positive(),
    status: z.enum(["shadow", "active", "superseded"]),
    sourceMode: z.enum(["voice_exemplars", "published_posts"]),
    publishedPostCount: z.number().int().min(0),
    calculationVersion: z.string().trim().min(1).max(120),
    inputFingerprint: z.string().trim().min(1).max(200),
    signals: z.array(learningSignalSchema).max(100),
    calculatedAt: timestampSchema,
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((model, context) => {
    const expectedMode =
      model.publishedPostCount < 5
        ? "voice_exemplars"
        : "published_posts";
    if (model.sourceMode !== expectedMode) {
      context.addIssue({
        code: "custom",
        message: `sourceMode must be ${expectedMode} for this published-post count`,
        path: ["sourceMode"],
      });
    }
  });
export type WorkspaceLearningModel = z.infer<
  typeof workspaceLearningModelSchema
>;

export type RefreshWorkspaceLearningOptions = {
  mode?: "shadow" | "active";
  force?: boolean;
  asOf?: string;
};

export interface ContentLineage {
  record(input: ArtifactLineageInput): Promise<ArtifactLineage | null>;
  getByArtifact(
    workspaceId: string,
    artifactId: string,
  ): Promise<ArtifactLineage | null>;
}

export interface WorkspaceKnowledge {
  propose(
    proposal: WorkspaceKnowledgeProposal,
  ): Promise<WorkspaceKnowledgeItem | null>;
  replaceInterviewProposals(
    workspaceId: string,
    sourceRefPrefix: string,
    proposals: WorkspaceKnowledgeProposal[],
  ): Promise<WorkspaceKnowledgeItem[] | null>;
  review(
    workspaceId: string,
    input: KnowledgeReviewInput,
  ): Promise<WorkspaceKnowledgeItem | null>;
  archive(
    workspaceId: string,
    itemId: string,
    expectedUpdatedAt: string,
  ): Promise<WorkspaceKnowledgeItem | null>;
  listProposed(workspaceId: string): Promise<WorkspaceKnowledgeItem[]>;
  listActiveBySource(
    workspaceId: string,
    source: KnowledgeItemSource,
    sourceRefPrefix: string,
  ): Promise<WorkspaceKnowledgeItem[]>;
  listActive(workspaceId: string): Promise<WorkspaceKnowledgeItem[]>;
}

export interface ContentOutcomes {
  ingest(outcome: ContentOutcome): Promise<ContentOutcome | null>;
  listByDraft(
    workspaceId: string,
    draftId: string,
  ): Promise<ContentOutcome[]>;
  correct(
    workspaceId: string,
    correction: ContentOutcomeCorrection,
  ): Promise<ContentOutcome | null>;
}

export interface WorkspaceLearning {
  refresh(
    workspaceId: string,
    options?: RefreshWorkspaceLearningOptions,
  ): Promise<WorkspaceLearningModel | null>;
  get(workspaceId: string): Promise<WorkspaceLearningModel | null>;
}
