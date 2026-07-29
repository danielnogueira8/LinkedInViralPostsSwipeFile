import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type BackgroundJob,
  markJobDone,
  markJobFailed,
} from "@/lib/background-jobs";
import {
  KNOWLEDGE_SOURCE_BUCKET,
  chunkKnowledgeText,
  parseKnowledgeDocument,
  sha256,
} from "@/lib/knowledge-sources/ingestion";

type Db = SupabaseClient;
type SourceKind = "file" | "note";

type PendingSource = {
  id: string;
  workspace_id: string;
  kind: SourceKind;
  title: string;
  status: "pending" | "processing" | "ready" | "failed" | "archived";
  ingestion_job_id: string | null;
  pending_storage_path: string | null;
};

export async function createPendingKnowledgeSource(input: {
  workspaceId: string;
  kind: SourceKind;
  title: string;
  originalFilename?: string | null;
  mimeType?: string | null;
  requestKey?: string | null;
  sizeBytes: number;
  db: Db;
}): Promise<PendingSource> {
  const { data, error } = await input.db.rpc(
    "create_pending_knowledge_source",
    {
      p_workspace_id: input.workspaceId,
      p_kind: input.kind,
      p_title: input.title,
      p_original_filename: input.originalFilename ?? null,
      p_mime_type: input.mimeType ?? null,
      p_request_key: input.requestKey ?? null,
      p_size_bytes: input.sizeBytes,
    },
  );
  if (error) throw error;
  return data as PendingSource;
}

export function knowledgeUploadPath(
  workspaceId: string,
  sourceId: string,
  filename: string,
): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 160);
  return `${workspaceId}/${sourceId}/${safeName}`;
}

export async function prepareKnowledgeSourceUpload(input: {
  workspaceId: string;
  sourceId: string;
  storagePath: string;
  db: Db;
}): Promise<void> {
  const { error } = await input.db.rpc("prepare_knowledge_source_upload", {
    p_workspace_id: input.workspaceId,
    p_source_id: input.sourceId,
    p_storage_path: input.storagePath,
  });
  if (error) throw error;
}

async function removePendingKnowledgeUpload(
  job: BackgroundJob,
  sourceId: string,
  db: Db,
): Promise<void> {
  const storagePath =
    typeof job.payload.storagePath === "string"
      ? job.payload.storagePath
      : null;
  if (!storagePath) return;
  if (!storagePath.startsWith(`${job.workspace_id}/${sourceId}/`)) {
    throw new Error("invalid_ingestion_payload");
  }
  const { error } = await db.storage
    .from(KNOWLEDGE_SOURCE_BUCKET)
    .remove([storagePath]);
  if (error) throw error;
}

export async function enqueueKnowledgeIngestion(input: {
  workspaceId: string;
  sourceId: string;
  kind: SourceKind;
  title: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename?: string | null;
  expectedHash?: string | null;
  storagePath?: string | null;
  rawText?: string | null;
  db: Db;
}) {
  const payload = {
      sourceId: input.sourceId,
      kind: input.kind,
      title: input.title,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      originalFilename: input.originalFilename ?? null,
      expectedHash: input.expectedHash ?? null,
      storagePath: input.storagePath ?? null,
      rawText: input.rawText ?? null,
  };
  const { data, error } = await input.db.rpc(
    "enqueue_knowledge_source_ingestion",
    {
      p_workspace_id: input.workspaceId,
      p_source_id: input.sourceId,
      p_payload: payload,
    },
  );
  if (error) throw error;
  return data as BackgroundJob;
}

const DETERMINISTIC_ERRORS = new Set([
  "file_type_mismatch",
  "no_extractable_text",
  "extracted_text_too_large",
  "content_hash_mismatch",
  "invalid_ingestion_payload",
]);

class PermanentKnowledgeIngestionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PermanentKnowledgeIngestionError";
  }
}

function payloadString(
  payload: Record<string, unknown>,
  key: string,
  optional = false,
): string | null {
  const value = payload[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (optional && (value === null || value === undefined)) return null;
  throw new Error("invalid_ingestion_payload");
}

export async function runKnowledgeIngestionJob(
  job: BackgroundJob,
  db: Db,
): Promise<{ completed: number; failed: number; requeued: number; unsupported: number }> {
  try {
    const sourceId = payloadString(job.payload, "sourceId")!;
    const kind = payloadString(job.payload, "kind") as SourceKind;
    const title = payloadString(job.payload, "title")!;
    const mimeType = payloadString(job.payload, "mimeType")!;
    const expectedHash = payloadString(job.payload, "expectedHash", true);
    const originalFilename = payloadString(
      job.payload,
      "originalFilename",
      true,
    );
    const storagePath = payloadString(job.payload, "storagePath", true);
    const rawText = payloadString(job.payload, "rawText", true);
    const sizeBytes = job.payload.sizeBytes;
    if (
      !["file", "note"].includes(kind) ||
      typeof sizeBytes !== "number" ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 1
    ) {
      throw new PermanentKnowledgeIngestionError("invalid_ingestion_payload");
    }

    let buffer: Buffer;
    if (kind === "file") {
      if (!storagePath?.startsWith(`${job.workspace_id}/${sourceId}/`)) {
        throw new Error("invalid_ingestion_payload");
      }
      const { data, error } = await db.storage
        .from(KNOWLEDGE_SOURCE_BUCKET)
        .download(storagePath);
      if (error) throw error;
      buffer = Buffer.from(await data.arrayBuffer());
    } else {
      if (!rawText) throw new Error("invalid_ingestion_payload");
      buffer = Buffer.from(rawText, "utf8");
    }
    if (buffer.byteLength > 20_000_000) {
      throw new PermanentKnowledgeIngestionError("file_too_large");
    }
    if (buffer.byteLength !== sizeBytes) {
      throw new PermanentKnowledgeIngestionError("content_hash_mismatch");
    }
    const contentHash = sha256(buffer);
    if (expectedHash && expectedHash !== contentHash) {
      throw new PermanentKnowledgeIngestionError("content_hash_mismatch");
    }
    let text: string;
    try {
      text =
        kind === "note"
          ? await parseKnowledgeDocument(buffer, "text/plain")
          : await parseKnowledgeDocument(buffer, mimeType);
    } catch {
      throw new PermanentKnowledgeIngestionError("document_parse_failed");
    }
    const chunks = chunkKnowledgeText(text);

    const { data: registration, error: registerError } = await db.rpc(
      "register_knowledge_source_revision",
      {
        p_workspace_id: job.workspace_id,
        p_kind: kind,
        p_title: title,
        p_content_hash: contentHash,
        p_size_bytes: buffer.byteLength,
        p_original_filename:
          kind === "file" ? originalFilename : null,
        p_mime_type: mimeType,
        p_storage_bucket: kind === "file" ? KNOWLEDGE_SOURCE_BUCKET : null,
        p_storage_path: kind === "file" ? storagePath : null,
        p_raw_text: kind === "note" ? text : null,
        p_source_id: sourceId,
      },
    );
    if (registerError) throw registerError;
    const row = Array.isArray(registration) ? registration[0] : registration;
    const revisionId = (row as { revision_id?: unknown } | null)?.revision_id;
    if (typeof revisionId !== "string") throw new Error("invalid_ingestion_payload");

    const { error: completeError } = await db.rpc(
      "complete_knowledge_source_ingestion",
      {
        p_workspace_id: job.workspace_id,
        p_source_id: sourceId,
        p_revision_id: revisionId,
        p_job_id: job.id,
        p_chunks: chunks,
      },
    );
    if (completeError) throw completeError;
    await markJobDone(job, { sourceId, revisionId, chunkCount: chunks.length }, db);
    return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
  } catch (error) {
    const code =
      error instanceof PermanentKnowledgeIngestionError
        ? error.code
        : error instanceof Error && DETERMINISTIC_ERRORS.has(error.message)
          ? error.message
          : "";
    if (!code) throw error;
    const sourceId =
      typeof job.payload.sourceId === "string" ? job.payload.sourceId : null;
    if (!sourceId) throw error;
    await removePendingKnowledgeUpload(job, sourceId, db);
    const { error: failError } = await db.rpc("fail_knowledge_source_ingestion", {
      p_workspace_id: job.workspace_id,
      p_source_id: sourceId,
      p_error_code: code,
      p_job_id: job.id,
    });
    if (failError) throw failError;
    await markJobFailed(job, "This source could not be processed.", db);
    return { completed: 0, failed: 1, requeued: 0, unsupported: 0 };
  }
}

export async function failKnowledgeIngestionAfterRetries(
  job: BackgroundJob,
  db: Db,
): Promise<void> {
  const sourceId =
    typeof job.payload.sourceId === "string" ? job.payload.sourceId : null;
  if (!sourceId) throw new Error("Invalid Knowledge Source job payload.");
  await removePendingKnowledgeUpload(job, sourceId, db);
  const { error } = await db.rpc("fail_knowledge_source_ingestion", {
    p_workspace_id: job.workspace_id,
    p_source_id: sourceId,
    p_error_code: "ingestion_retries_exhausted",
    p_job_id: job.id,
  });
  if (error) throw error;
}
