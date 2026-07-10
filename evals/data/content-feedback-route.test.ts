import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";
import { CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX } from "@/lib/content-feedback";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
const CHAT_ID = "00000000-0000-4000-8000-000000000020";
const DRAFT_ID = "00000000-0000-4000-8000-000000000030";

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws-feedback",
    raw: dbRef.current.client,
  }),
}));

const { GET, POST } = await import("@/app/api/content-feedback/route");
const { DELETE } = await import("@/app/api/content-feedback/[id]/route");

function req(body: unknown): Request {
  return new Request("http://t/api/content-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq(query = ""): Request {
  return new Request(`http://t/api/content-feedback${query}`, {
    method: "GET",
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

describe("GET /api/content-feedback", () => {
  test("lists recent workspace-scoped feedback", async () => {
    dbRef.current = makeFakeSupabase({
      content_feedback: {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000011",
            workspace_id: "ws-feedback",
            chat_id: null,
            artifact_id: null,
            draft_id: null,
            rating: "down",
            reasons: ["Too generic"],
            note: null,
            body_snapshot: "body",
            created_at: "2026-07-06T00:00:00.000Z",
          },
        ],
      },
    });

    const res = await GET(getReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.feedback).toHaveLength(1);
    const q = queryFor(dbRef.current, "content_feedback")!;
    expect(q.selectArg).toContain("body_snapshot");
    expect(q.filters).toEqual([
      { method: "eq", args: ["workspace_id", "ws-feedback"] },
      { method: "order", args: ["created_at", { ascending: false }] },
      { method: "limit", args: [20] },
    ]);
  });

  test("filters by rating and clamps limit", async () => {
    await GET(getReq("?rating=up&limit=999"));

    const q = queryFor(dbRef.current, "content_feedback")!;
    expect(q.filters).toContainEqual({ method: "eq", args: ["rating", "up"] });
    expect(q.filters).toContainEqual({ method: "limit", args: [50] });
  });

  test("rejects invalid rating without querying", async () => {
    const res = await GET(getReq("?rating=maybe"));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(queryFor(dbRef.current, "content_feedback")).toBeUndefined();
  });
});

describe("POST /api/content-feedback", () => {
  test("inserts workspace-scoped feedback", async () => {
    dbRef.current = makeFakeSupabase({
      chats: {
        single: { id: CHAT_ID },
      },
      chat_messages: {
        rows: [
          {
            id: "msg_1",
            artifacts: [{ id: "artifact_1", body: "body" }],
          },
        ],
      },
      content_feedback: {
        single: {
          id: "00000000-0000-4000-8000-000000000010",
          workspace_id: "ws-feedback",
          chat_id: CHAT_ID,
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
    const res = await POST(
      req({
        rating: "up",
        reasons: ["Right voice"],
        bodySnapshot: "body",
        chatId: CHAT_ID,
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
      chat_id: CHAT_ID,
      artifact_id: "artifact_1",
    });
    expect(q.selectArg).toContain("workspace_id");
    expect(q.terminal).toBe("single");
  });

  test("truncates large body snapshots before insert", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: {
        single: {
          id: DRAFT_ID,
          chat_id: null,
        },
      },
      content_feedback: {
        single: {
          id: "00000000-0000-4000-8000-000000000010",
          workspace_id: "ws-feedback",
          chat_id: null,
          artifact_id: null,
          draft_id: DRAFT_ID,
          rating: "down",
          reasons: ["Too long"],
          note: null,
          body_snapshot: "body",
          created_at: "2026-07-06T00:00:00.000Z",
        },
      },
    });
    const bodySnapshot = "x".repeat(CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX + 100);
    await POST(
      req({
        rating: "down",
        reasons: ["Too long"],
        bodySnapshot,
        draftId: DRAFT_ID,
      }),
    );

    const q = queryFor(dbRef.current, "content_feedback")!;
    const insert = q.filters.find((f) => f.method === "insert")!;
    const payload = insert.args[0] as Record<string, unknown>;
    expect(String(payload.body_snapshot).length).toBe(
      CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX,
    );
  });

  test("rejects feedback without a verifiable subject", async () => {
    const res = await POST(
      req({
        rating: "up",
        reasons: ["Right voice"],
        bodySnapshot: "body",
      }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("draft or chat");
    expect(queryFor(dbRef.current, "content_feedback")).toBeUndefined();
  });

  test("rejects artifact feedback when the artifact is not in the chat", async () => {
    dbRef.current = makeFakeSupabase({
      chats: {
        single: { id: CHAT_ID },
      },
      chat_messages: {
        rows: [
          {
            id: "msg_1",
            artifacts: [{ id: "different_artifact" }],
          },
        ],
      },
    });

    const res = await POST(
      req({
        rating: "down",
        reasons: ["Bad format"],
        bodySnapshot: "body",
        chatId: CHAT_ID,
        artifactId: "artifact_1",
      }),
    );
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.ok).toBe(false);
    expect(data.error).toBe("Artifact not found");
    expect(queryFor(dbRef.current, "content_feedback")).toBeUndefined();
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

describe("DELETE /api/content-feedback/[id]", () => {
  test("deletes by id and workspace", async () => {
    dbRef.current = makeFakeSupabase({
      content_feedback: {
        rows: [{ id: "00000000-0000-4000-8000-000000000010" }],
      },
    });

    const res = await DELETE(new Request("http://t"), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000010" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    const q = queryFor(dbRef.current, "content_feedback")!;
    expect(q.filters.map((f) => f.method)).toEqual(["delete", "eq", "eq"]);
    expect(q.filters[1].args).toEqual([
      "id",
      "00000000-0000-4000-8000-000000000010",
    ]);
    expect(q.filters[2].args).toEqual(["workspace_id", "ws-feedback"]);
  });

  test("returns 404 when no workspace row was deleted", async () => {
    dbRef.current = makeFakeSupabase({
      content_feedback: { rows: [] },
    });

    const res = await DELETE(new Request("http://t"), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000010" }),
    });
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.ok).toBe(false);
  });
});
