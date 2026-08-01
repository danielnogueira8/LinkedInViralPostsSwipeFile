import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";

const dbRef: { current: FakeDb } = {
  current: makeFakeSupabase({}),
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: dbRef.current.client,
  }),
}));

const { POST } = await import(
  "@/app/api/knowledge-sources/[id]/insights/route"
);

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

function context(id = SOURCE_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

describe("POST /api/knowledge-sources/:id/insights", () => {
  test("requeues failed analysis through the workspace-scoped database operation", async () => {
    dbRef.current = makeFakeSupabase(
      {
        app_schema_version: { single: { version: 152 } },
      },
      {
        retry_knowledge_source_extraction: {
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            status: "queued",
          },
        },
      },
    );

    const response = await POST(new Request("https://example.test"), context());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      jobId: "22222222-2222-4222-8222-222222222222",
      status: "queued",
    });
    expect(dbRef.current.rpcs).toContainEqual({
      name: "retry_knowledge_source_extraction",
      args: {
        p_workspace_id: "workspace-1",
        p_source_id: SOURCE_ID,
      },
    });
  });

  test("rejects an invalid source id without touching the database", async () => {
    const response = await POST(
      new Request("https://example.test"),
      context("not-a-source"),
    );

    expect(response.status).toBe(400);
    expect(dbRef.current.rpcs).toEqual([]);
  });
});
