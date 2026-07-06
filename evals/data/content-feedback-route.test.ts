import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";
import { CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX } from "@/lib/content-feedback";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws-feedback",
    raw: dbRef.current.client,
  }),
}));

const { POST } = await import("@/app/api/content-feedback/route");

function req(body: unknown): Request {
  return new Request("http://t/api/content-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  dbRef.current = makeFakeSupabase({
    content_feedback: {
      single: {
        id: "00000000-0000-4000-8000-000000000010",
        workspace_id: "ws-feedback",
        chat_id: null,
        artifact_id: "artifact_1",
        draft_id: null,
        rating: "up",
        reasons: ["Right voice"],
        note: null,
        body_snapshot: "body",
        created_at: "2026-07-06T00:00:00.000Z",
      },
    },
  });
});

describe("POST /api/content-feedback", () => {
  test("inserts workspace-scoped feedback", async () => {
    const res = await POST(
      req({
        rating: "up",
        reasons: ["Right voice"],
        bodySnapshot: "body",
        artifactId: "artifact_1",
      }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    const q = queryFor(dbRef.current, "content_feedback")!;
    const insert = q.filters.find((f) => f.method === "insert")!;
    expect(insert.args[0]).toMatchObject({
      workspace_id: "ws-feedback",
      rating: "up",
      reasons: ["Right voice"],
      body_snapshot: "body",
      artifact_id: "artifact_1",
    });
    expect(q.selectArg).toContain("workspace_id");
    expect(q.terminal).toBe("single");
  });

  test("truncates large body snapshots before insert", async () => {
    const bodySnapshot = "x".repeat(CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX + 100);
    await POST(
      req({
        rating: "down",
        reasons: ["Too long"],
        bodySnapshot,
      }),
    );

    const q = queryFor(dbRef.current, "content_feedback")!;
    const insert = q.filters.find((f) => f.method === "insert")!;
    const payload = insert.args[0] as Record<string, unknown>;
    expect(String(payload.body_snapshot).length).toBe(
      CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX,
    );
  });

  test("rejects unsupported reasons without inserting", async () => {
    const res = await POST(
      req({
        rating: "down",
        reasons: ["Make it fancy"],
        bodySnapshot: "body",
      }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(queryFor(dbRef.current, "content_feedback")).toBeUndefined();
  });
});
