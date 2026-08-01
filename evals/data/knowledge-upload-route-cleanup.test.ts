import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    cleanupError: new Error("storage cleanup unavailable"),
    failCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    source: {
      id: "10000000-0000-4000-8000-000000000001",
      title: "Evidence",
      mime_type: "text/plain",
      original_filename: "evidence.txt",
      status: "pending",
      request_key: "file:" + "a".repeat(64),
      ingestion_job_id: null,
      pending_storage_path:
        "workspace-1/10000000-0000-4000-8000-000000000001/evidence.txt",
      declared_size_bytes: 20,
    },
    objects: [{ name: "evidence.txt", metadata: { size: "10" } }],
  };

  const raw = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "fail_knowledge_source_ingestion") {
        state.failCalls.push({ name, args });
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      if (table !== "knowledge_sources") {
        throw new Error(`unexpected table ${table}`);
      }
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: state.source, error: null }),
      });
      return chain;
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => ({
          data: null,
          error: new Error("signed upload unavailable"),
        }),
        list: async () => ({ data: state.objects, error: null }),
        remove: async () => ({ error: state.cleanupError }),
      }),
    },
  };

  return { state, raw };
});

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: mocks.raw,
  }),
}));
vi.mock("@/lib/knowledge-sources/ingestion", () => ({
  KNOWLEDGE_SOURCE_BUCKET: "knowledge-sources",
  validateKnowledgeUpload: () => ({ ok: true, mimeType: "text/plain" }),
  matchesDeclaredKnowledgeSize: () => false,
}));
vi.mock("@/lib/knowledge-sources/operations", () => ({
  createPendingKnowledgeSource: async () => mocks.state.source,
  knowledgeUploadPath: () => mocks.state.source.pending_storage_path,
  prepareKnowledgeSourceUpload: async () => undefined,
  enqueueKnowledgeIngestion: async () => ({ id: "job-1" }),
}));

const { POST: startUpload } = await import(
  "@/app/api/knowledge-sources/uploads/route"
);
const { POST: completeUpload } = await import(
  "@/app/api/knowledge-sources/uploads/complete/route"
);

const SOURCE_ID = mocks.state.source.id;
const CONTENT_HASH = "a".repeat(64);

function request(body: unknown, path: string): Request {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.state.failCalls = [];
});

describe("Knowledge Source upload failure cleanup", () => {
  test("marks the source failed even when signed-upload cleanup fails", async () => {
    const response = await startUpload(
      request(
        {
          title: "Evidence",
          filename: "evidence.txt",
          mimeType: "text/plain",
          sizeBytes: 20,
          contentHash: CONTENT_HASH,
        },
        "/api/knowledge-sources/uploads",
      ),
    );

    expect(response.status).toBe(500);
    expect(mocks.state.failCalls).toEqual([
      {
        name: "fail_knowledge_source_ingestion",
        args: {
          p_workspace_id: "workspace-1",
          p_source_id: SOURCE_ID,
          p_error_code: "upload_initialization_failed",
          p_job_id: null,
        },
      },
    ]);
  });

  test("marks a size-mismatched upload failed even when object removal fails", async () => {
    const response = await completeUpload(
      request(
        {
          sourceId: SOURCE_ID,
          path: mocks.state.source.pending_storage_path,
          contentHash: CONTENT_HASH,
        },
        "/api/knowledge-sources/uploads/complete",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.state.failCalls).toEqual([
      {
        name: "fail_knowledge_source_ingestion",
        args: {
          p_workspace_id: "workspace-1",
          p_source_id: SOURCE_ID,
          p_error_code: "uploaded_size_mismatch",
          p_job_id: null,
        },
      },
    ]);
  });
});
