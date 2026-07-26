import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  CONTENT_LEARNING_SCHEMA_VERSION,
  contentOutcomeCorrectionSchema,
  contentOutcomeKindSchema,
  contentOutcomeSchema,
  type ContentOutcome,
  type ContentOutcomes,
} from "@/lib/content-learning/contracts";

const outcomeFields = {
  kind: contentOutcomeKindSchema,
  quantity: z.number().int().min(1).max(1_000_000),
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase())
    .nullable(),
  occurredAt: z.string().datetime({ offset: true }),
};

function validateMoney(
  value: { amountMinor: number | null; currency: string | null },
  context: z.RefinementCtx,
) {
  if ((value.amountMinor === null) !== (value.currency === null)) {
    context.addIssue({
      code: "custom",
      message: "Amount and currency must be provided together",
      path: [value.amountMinor === null ? "amountMinor" : "currency"],
    });
  }
}

export const manualOutcomeInputSchema = z
  .object({
    ...outcomeFields,
    requestId: z.string().uuid(),
  })
  .strict()
  .superRefine(validateMoney);

export const manualOutcomeCorrectionInputSchema = z
  .object({
    ...outcomeFields,
    outcomeId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().min(1).max(1_000),
    requestId: z.string().uuid(),
  })
  .strict()
  .superRefine(validateMoney);

type OutcomeRow = {
  id: string;
  schema_version: number;
  workspace_id: string;
  draft_id: string;
  lineage_id: string | null;
  kind: ContentOutcome["kind"];
  source: ContentOutcome["source"];
  external_id: string | null;
  idempotency_key: string;
  status: ContentOutcome["status"];
  supersedes_outcome_id: string | null;
  confidence: number;
  quantity: number;
  amount_minor: number | null;
  currency: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
};

const OUTCOME_COLUMNS =
  "id, schema_version, workspace_id, draft_id, lineage_id, kind, source, external_id, idempotency_key, status, supersedes_outcome_id, confidence, quantity, amount_minor, currency, occurred_at, created_at, updated_at";
export const CONTENT_OUTCOME_LIST_LIMIT = 100;

export function contentOutcomeFromRow(row: OutcomeRow): ContentOutcome | null {
  const parsed = contentOutcomeSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    workspaceId: row.workspace_id,
    draftId: row.draft_id,
    lineageId: row.lineage_id,
    kind: row.kind,
    source: row.source,
    externalId: row.external_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    supersedesOutcomeId: row.supersedes_outcome_id,
    confidence: row.confidence,
    quantity: row.quantity,
    amountMinor: row.amount_minor,
    currency: row.currency,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

export function createContentOutcomesStore(
  db: SupabaseClient,
  onFailure: (operation: string, error: unknown) => void = (operation, error) =>
    console.warn("[content-outcomes] operation failed", {
      operation,
      error: error instanceof Error ? error.message : String(error),
    }),
): ContentOutcomes {
  async function byIdempotency(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<ContentOutcome | null> {
    const { data, error } = await db
      .from("content_outcomes")
      .select(OUTCOME_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const parsed = contentOutcomeFromRow(data as OutcomeRow);
    if (!parsed) throw new Error("Stored Content Outcome is invalid");
    return parsed;
  }

  return {
    async ingest(outcome) {
      const parsed = contentOutcomeSchema.safeParse(outcome);
      if (
        !parsed.success ||
        parsed.data.status !== "active" ||
        parsed.data.supersedesOutcomeId !== null
      ) {
        onFailure(
          "ingest",
          parsed.success
            ? new Error("New outcomes must enter active and cannot replace another outcome")
            : parsed.error,
        );
        return null;
      }
      const value = parsed.data;
      try {
        const { error } = await db.from("content_outcomes").upsert(
          {
            id: value.id,
            schema_version: value.schemaVersion,
            workspace_id: value.workspaceId,
            draft_id: value.draftId,
            lineage_id: value.lineageId,
            kind: value.kind,
            source: value.source,
            external_id: value.externalId,
            idempotency_key: value.idempotencyKey,
            status: value.status,
            supersedes_outcome_id: value.supersedesOutcomeId,
            confidence: value.confidence,
            quantity: value.quantity,
            amount_minor: value.amountMinor,
            currency: value.currency,
            occurred_at: value.occurredAt,
          },
          {
            onConflict: "workspace_id,idempotency_key",
            ignoreDuplicates: true,
          },
        );
        if (error) throw error;
        return await byIdempotency(value.workspaceId, value.idempotencyKey);
      } catch (error) {
        onFailure("ingest", error);
        return null;
      }
    },

    async listByDraft(workspaceId, draftId) {
      try {
        const { data, error } = await db
          .from("content_outcomes")
          .select(OUTCOME_COLUMNS)
          .eq("workspace_id", workspaceId)
          .eq("draft_id", draftId)
          .eq("status", "active")
          .order("occurred_at", { ascending: false })
          .limit(CONTENT_OUTCOME_LIST_LIMIT);
        if (error) throw error;
        return (data ?? []).map((row) => {
          const parsed = contentOutcomeFromRow(row as OutcomeRow);
          if (!parsed) {
            throw new Error("Stored Content Outcome is invalid");
          }
          return parsed;
        });
      } catch (error) {
        onFailure("listByDraft", error);
        throw error;
      }
    },

    async correct(workspaceId, correction) {
      const parsed = contentOutcomeCorrectionSchema.safeParse(correction);
      if (!parsed.success) {
        onFailure("correct", parsed.error);
        return null;
      }
      try {
        const value = parsed.data;
        const { data, error } = await db.rpc("correct_content_outcome", {
          p_workspace_id: workspaceId,
          p_outcome_id: value.outcomeId,
          p_expected_updated_at: value.expectedUpdatedAt,
          p_reason: value.reason,
          p_idempotency_key: value.idempotencyKey,
          p_kind: value.replacement.kind,
          p_confidence: value.replacement.confidence,
          p_quantity: value.replacement.quantity,
          p_amount_minor: value.replacement.amountMinor,
          p_currency: value.replacement.currency,
          p_occurred_at: value.replacement.occurredAt,
        });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        const result = row
          ? contentOutcomeFromRow(row as OutcomeRow)
          : null;
        if (!result) throw new Error("Corrected Content Outcome is invalid");
        return result;
      } catch (error) {
        onFailure("correct", error);
        return null;
      }
    },
  };
}

export function buildManualOutcome(input: {
  id: string;
  workspaceId: string;
  draftId: string;
  lineageId: string | null;
  requestId: string;
  kind: ContentOutcome["kind"];
  quantity: number;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: string;
  now: string;
}): ContentOutcome {
  return contentOutcomeSchema.parse({
    schemaVersion: CONTENT_LEARNING_SCHEMA_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    draftId: input.draftId,
    lineageId: input.lineageId,
    kind: input.kind,
    source: "manual",
    externalId: null,
    idempotencyKey: `manual:${input.draftId}:${input.requestId}`,
    status: "active",
    supersedesOutcomeId: null,
    confidence: 1,
    quantity: input.quantity,
    amountMinor: input.amountMinor,
    currency: input.currency,
    occurredAt: input.occurredAt,
    createdAt: input.now,
    updatedAt: input.now,
  });
}
