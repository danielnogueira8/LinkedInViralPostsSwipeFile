import type { SupabaseClient } from "@supabase/supabase-js";
import {
  artifactLineageInputSchema,
  artifactLineageSchema,
  type ArtifactLineage,
  type ArtifactLineageInput,
  type ContentLineage,
} from "@/lib/content-learning/contracts";

type ArtifactLineageRow = {
  id: string;
  schema_version: number;
  workspace_id: string;
  artifact_id: string;
  parent_artifact_id: string | null;
  cowork_command: ArtifactLineageInput["coworkCommand"];
  cowork_chat_id: string | null;
  cowork_user_message_id: string | null;
  user_direction: string;
  inputs: unknown;
  origin: unknown;
  generation_model: string;
  generated_at: string;
  descriptor: unknown;
  created_at: string;
};

export type ContentLineageFailure = {
  operation: "record" | "get";
  error: unknown;
};

export type ContentLineageStoreOptions = {
  onFailure?: (failure: ContentLineageFailure) => void;
};

function defaultFailureReporter(failure: ContentLineageFailure): void {
  console.warn("[content-lineage] operation failed", {
    operation: failure.operation,
    error:
      failure.error instanceof Error
        ? failure.error.message
        : String(failure.error),
  });
}

export function artifactLineageInputToRow(
  input: ArtifactLineageInput,
): Omit<ArtifactLineageRow, "id" | "created_at"> {
  return {
    schema_version: input.schemaVersion,
    workspace_id: input.workspaceId,
    artifact_id: input.artifactId,
    parent_artifact_id: input.parentArtifactId,
    cowork_command: input.coworkCommand,
    cowork_chat_id: input.coworkTurn?.chatId ?? null,
    cowork_user_message_id: input.coworkTurn?.userMessageId ?? null,
    user_direction: input.userDirection,
    inputs: input.inputs,
    origin: input.origin,
    generation_model: input.generationModel,
    generated_at: input.generatedAt,
    descriptor: input.descriptor,
  };
}

export function artifactLineageFromRow(
  row: ArtifactLineageRow,
): ArtifactLineage | null {
  const parsed = artifactLineageSchema.safeParse({
    id: row.id,
    schemaVersion: row.schema_version,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    parentArtifactId: row.parent_artifact_id,
    coworkCommand: row.cowork_command,
    coworkTurn:
      row.cowork_chat_id && row.cowork_user_message_id
        ? {
            chatId: row.cowork_chat_id,
            userMessageId: row.cowork_user_message_id,
          }
        : null,
    userDirection: row.user_direction,
    inputs: row.inputs,
    origin: row.origin,
    generationModel: row.generation_model,
    generatedAt: row.generated_at,
    descriptor: row.descriptor,
    createdAt: row.created_at,
  });
  return parsed.success ? parsed.data : null;
}

export function createContentLineageStore(
  db: SupabaseClient,
  options: ContentLineageStoreOptions = {},
): ContentLineage {
  const report = options.onFailure ?? defaultFailureReporter;

  const getByArtifact = async (
    workspaceId: string,
    artifactId: string,
  ): Promise<ArtifactLineage | null> => {
    try {
      const { data, error } = await db
        .from("artifact_lineage")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("artifact_id", artifactId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const lineage = artifactLineageFromRow(data as ArtifactLineageRow);
      if (!lineage) throw new Error("Stored Artifact lineage is invalid");
      return lineage;
    } catch (error) {
      report({ operation: "get", error });
      return null;
    }
  };

  return {
    async record(input) {
      const parsed = artifactLineageInputSchema.safeParse(input);
      if (!parsed.success) {
        report({ operation: "record", error: parsed.error });
        return null;
      }

      try {
        const row = artifactLineageInputToRow(parsed.data);
        const { data, error } = await db.rpc("record_artifact_lineage", {
          p_schema_version: row.schema_version,
          p_workspace_id: row.workspace_id,
          p_artifact_id: row.artifact_id,
          p_parent_artifact_id: row.parent_artifact_id,
          p_cowork_command: row.cowork_command,
          p_cowork_chat_id: row.cowork_chat_id,
          p_cowork_user_message_id: row.cowork_user_message_id,
          p_user_direction: row.user_direction,
          p_inputs: row.inputs,
          p_origin: row.origin,
          p_generation_model: row.generation_model,
          p_generated_at: row.generated_at,
          p_descriptor: row.descriptor,
        });
        if (error) throw error;
        const persisted = Array.isArray(data) ? data[0] : data;
        if (!persisted) throw new Error("Artifact lineage write returned no row");
        const lineage = artifactLineageFromRow(
          persisted as ArtifactLineageRow,
        );
        if (!lineage) throw new Error("Stored Artifact lineage is invalid");
        return lineage;
      } catch (error) {
        report({ operation: "record", error });
        return null;
      }
    },
    getByArtifact,
  };
}
