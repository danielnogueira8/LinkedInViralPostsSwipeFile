import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Artifact } from "@/lib/agent/contracts";
import type { DraftRecord } from "@/lib/draft-lifecycle";
import { createContentLineageStore } from "@/lib/content-learning/lineage";
import { explorationLaneSchema } from "@/lib/content-learning/contracts";
import { supabaseAdmin } from "@/lib/supabase";

const nullableId = z.string().trim().min(1).max(160).nullable();

export const generationLineageSeedSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceArtifactId: z.string().trim().min(1).max(200),
    userMessageId: z.string().uuid(),
    coworkCommand: z.enum(["create", "edit"]),
    parentArtifactId: nullableId,
    modelSourceId: nullableId,
    contentTemplateId: nullableId,
    creatorStyleId: nullableId,
    customSkillIds: z.array(z.string().trim().min(1).max(160)).max(20),
    leadMagnetId: nullableId,
    voiceProfileRevision: nullableId,
    explorationLane: explorationLaneSchema.nullable().optional(),
    generationModel: z.string().trim().min(1).max(200),
    generatedAt: z.string().datetime({ offset: true }),
    knowledgeSources: z
      .array(
        z
          .object({
            sourceId: nullableId.unwrap(),
            sourceRevisionId: nullableId.unwrap(),
            chunkIds: z.array(nullableId.unwrap()).max(6),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

export type GenerationLineageSeed = z.infer<
  typeof generationLineageSeedSchema
>;

export type SavedDraftLineageOrigin = {
  weekPlanItemId?: string;
  opportunityId?: string;
};

export function savedDraftParentId(artifact: Artifact | null): string | null {
  const candidate = artifact?.meta?.board_draft_id;
  return typeof candidate === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate,
    )
    ? candidate
    : null;
}

export function tagArtifactWithGenerationLineage(
  artifact: Artifact,
  seed: GenerationLineageSeed,
): Artifact {
  if (artifact.kind === "cite") return artifact;
  const parsed = generationLineageSeedSchema.safeParse(seed);
  if (!parsed.success) return artifact;
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      content_lineage: parsed.data,
    },
  };
}

type UserMessageRow = {
  id: string;
  chat_id: string;
  content: string;
  created_at: string;
};

type AssistantMessageRow = {
  artifacts: unknown;
};

/**
 * Persist a saved Draft's generation provenance beside the legacy metadata.
 * Missing/invalid seeds and storage failures are deliberately fail-open: saving
 * the user's Draft remains the primary transaction.
 */
export async function recordSavedDraftLineage(
  db: SupabaseClient,
  workspaceId: string,
  draft: DraftRecord,
  trustedOrigin: SavedDraftLineageOrigin = {},
  lineageDb?: SupabaseClient,
): Promise<void> {
  const parsedSeed = generationLineageSeedSchema.safeParse(
    draft.meta?.content_lineage,
  );
  if (!parsedSeed.success || !draft.chatId) return;

  try {
    const { data, error } = await db
      .from("chat_messages")
      .select("id, chat_id, content, created_at")
      .eq("id", parsedSeed.data.userMessageId)
      .eq("chat_id", draft.chatId)
      .eq("workspace_id", workspaceId)
      .eq("role", "user")
      .maybeSingle();
    if (error) throw error;
    if (!data) return;

    const userMessage = data as UserMessageRow;
    const { data: assistantRows, error: assistantError } = await db
      .from("chat_messages")
      .select("artifacts")
      .eq("chat_id", draft.chatId)
      .eq("workspace_id", workspaceId)
      .eq("role", "assistant")
      .not("artifacts", "is", null)
      .contains("artifacts", [{ id: parsedSeed.data.sourceArtifactId }])
      .order("created_at", { ascending: false });
    if (assistantError) throw assistantError;

    const trustedSeed = (assistantRows as AssistantMessageRow[] | null)
      ?.flatMap((row) => (Array.isArray(row.artifacts) ? row.artifacts : []))
      .find((artifact) => {
        if (!artifact || typeof artifact !== "object") return false;
        const candidate = artifact as {
          body?: unknown;
          meta?: { content_lineage?: unknown };
        };
        const candidateSeed = generationLineageSeedSchema.safeParse(
          candidate.meta?.content_lineage,
        );
        return (
          candidateSeed.success &&
          candidateSeed.data.sourceArtifactId ===
            parsedSeed.data.sourceArtifactId &&
          candidateSeed.data.userMessageId === userMessage.id
        );
      });
    if (!trustedSeed || typeof trustedSeed !== "object") return;
    const trustedSeedResult = generationLineageSeedSchema.safeParse(
      (trustedSeed as { meta?: { content_lineage?: unknown } }).meta
        ?.content_lineage,
    );
    if (!trustedSeedResult.success) return;
    const seed = trustedSeedResult.data;

    const weekPlanItemId = trustedOrigin.weekPlanItemId?.trim() || null;
    const opportunityId = trustedOrigin.opportunityId?.trim() || null;
    const originKind = weekPlanItemId
      ? "week_plan"
      : opportunityId
        ? "agent_opportunity"
        : "cowork";

    await createContentLineageStore(lineageDb ?? supabaseAdmin()).record({
      schemaVersion: 1,
      workspaceId,
      artifactId: draft.id,
      parentArtifactId: seed.parentArtifactId,
      coworkCommand: seed.coworkCommand,
      coworkTurn: {
        chatId: userMessage.chat_id,
        userMessageId: userMessage.id,
      },
      userDirection: userMessage.content,
      inputs: {
        modelSourceId: seed.modelSourceId,
        contentTemplateId: seed.contentTemplateId,
        creatorStyleId: seed.creatorStyleId,
        customSkillIds: seed.customSkillIds,
        leadMagnetId: seed.leadMagnetId,
        voiceProfileRevision: seed.voiceProfileRevision,
        explorationLane: seed.explorationLane ?? null,
        knowledgeSources: seed.knowledgeSources ?? [],
      },
      origin: {
        kind: originKind,
        weekPlanItemId,
        opportunityId,
      },
      generationModel: seed.generationModel,
      generatedAt: seed.generatedAt,
      descriptor: {
        topic: draft.title?.trim().slice(0, 240) || null,
        hookType: null,
        structure: null,
        ctaType: null,
      },
    });
  } catch (error) {
    console.warn("[content-lineage] generation dual-write failed", {
      operation: "record",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
