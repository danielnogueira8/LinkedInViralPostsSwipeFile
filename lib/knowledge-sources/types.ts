export type KnowledgeSourceStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed";

export type KnowledgeSourceSummary = {
  id: string;
  kind: "file" | "note";
  title: string;
  originalFilename: string | null;
  mimeType: string | null;
  status: KnowledgeSourceStatus;
  errorCode: string | null;
  sizeBytes: number | null;
  jobId: string | null;
  extractionStatus: "queued" | "running" | "done" | "failed" | null;
  extractionErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredKnowledgeSource = {
  id: string;
  kind: "file" | "note";
  title: string;
  original_filename: string | null;
  mime_type: string | null;
  status: KnowledgeSourceStatus;
  error_code: string | null;
  declared_size_bytes: number | null;
  ingestion_job_id: string | null;
  extraction_job?: { status?: string } | Array<{ status?: string }> | null;
  extraction_error_code?: string | null;
  created_at: string;
  updated_at: string;
};

export function publicKnowledgeSource(
  row: StoredKnowledgeSource,
): KnowledgeSourceSummary {
  const extractionJob = Array.isArray(row.extraction_job)
    ? row.extraction_job[0]
    : row.extraction_job;
  const extractionStatus = ["queued", "running", "done", "failed"].includes(
    extractionJob?.status ?? "",
  )
    ? (extractionJob!.status as KnowledgeSourceSummary["extractionStatus"])
    : null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    status: row.status,
    errorCode: row.error_code,
    sizeBytes: row.declared_size_bytes,
    jobId: row.ingestion_job_id,
    extractionStatus,
    extractionErrorCode: row.extraction_error_code ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type KnowledgeProposalDetail = {
  id: string;
  kind:
    | "story"
    | "belief"
    | "proof"
    | "offer"
    | "audience_insight"
    | "topic_expertise"
    | "prohibition";
  title: string;
  content: Record<string, string | null>;
  confidence: number;
  verification: "proposed" | "verified" | "rejected";
  updatedAt: string;
  evidence: Array<{
    excerpt: string;
    startOffset: number;
    endOffset: number;
  }>;
};

export function knowledgeFailureMessage(code: string | null): string {
  switch (code) {
    case "file_too_large":
    case "invalid_uploaded_file":
      return "The file is larger than allowed or has an unsupported format.";
    case "uploaded_size_mismatch":
      return "The uploaded file changed. Choose it again.";
    case "file_type_mismatch":
      return "The file contents do not match its format.";
    case "no_extractable_text":
      return "No readable text was found in this source.";
    case "document_parse_failed":
      return "This document could not be read. Try exporting it as PDF or text.";
    case "ingestion_retries_exhausted":
      return "Processing could not finish after several attempts.";
    default:
      return "This source could not be processed.";
  }
}

export function formatKnowledgeBytes(sizeBytes: number | null): string {
  if (!sizeBytes || sizeBytes < 1) return "";
  if (sizeBytes < 1000) return `${sizeBytes} B`;
  if (sizeBytes < 1_000_000) return `${(sizeBytes / 1000).toFixed(1)} KB`;
  return `${(sizeBytes / 1_000_000).toFixed(1)} MB`;
}

export function formatKnowledgeDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

export function canonicalKnowledgeMimeType(
  filename: string,
  browserMimeType: string,
): string {
  const extension = filename.toLowerCase().split(".").pop();
  switch (extension) {
    case "txt":
    case "md":
    case "markdown":
    case "log":
      return "text/plain";
    case "csv":
      return "text/csv";
    case "tsv":
      return "text/tab-separated-values";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "rtf":
      return "application/rtf";
    default:
      return browserMimeType || "application/octet-stream";
  }
}
