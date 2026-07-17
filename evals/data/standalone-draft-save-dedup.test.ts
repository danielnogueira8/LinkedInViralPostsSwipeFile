import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/drafts ("New post") and the create_draft MCP tool both share
// DraftLifecycle.create() -> createStandalone(), which used to insert a
// fresh chat_artifacts row EVERY time (no dedup at all) — a retried MCP call
// (timeout, an LLM calling the tool twice) or a double-click on "New post"
// created duplicate drafts. This is the server-side guard: if this workspace
// already saved a standalone (chat_id is null) row with this EXACT body
// recently, return that row instead of inserting a duplicate.
//
// Scoped to (workspace_id, chat_id IS NULL, body) with a time window — NOT
// forever — so a genuinely new draft with coincidentally identical text to
// something created weeks ago still gets its own row. This is a retry
// guard, not a "no two identical posts ever" rule.
// ---------------------------------------------------------------------------

const state: {
  existingRow: Record<string, unknown> | null;
  insertResult: Record<string, unknown> | null;
  lastRpcArgs: Record<string, unknown>;
} = {
  existingRow: null,
  insertResult: {
    id: "new-draft",
    title: "T",
    body: "B",
    meta: null,
    media_attachments: [],
    created_at: "2026-01-01",
  },
  lastRpcArgs: {},
};

const fakeRaw = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name !== "save_standalone_draft") throw new Error(`unexpected rpc ${name}`);
    state.lastRpcArgs = args;
    const deduped = Boolean(state.existingRow);
    const source = (state.existingRow ?? state.insertResult) as Record<string, unknown>;
    return {
      data: {
        outcome: deduped ? "deduped" : "saved",
        draft: {
          kind: "post",
          status: "drafting",
          plan_to_post_on: null,
          chat_id: null,
          scheduled_at: null,
          schedule_status: null,
          first_comment: null,
          published_at: null,
          publish_error: null,
          ...source,
        },
      },
      error: null,
    };
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws1", raw: fakeRaw }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { POST } = await import("@/app/api/drafts/route");

function newPostRequest(body: Record<string, unknown>): Request {
  return new Request("http://t/api/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.existingRow = null;
  state.lastRpcArgs = {};
});

describe("POST /api/drafts — standalone draft dedup", () => {
  test("first create of new content: no existing row, saved outcome", async () => {
    const res = await POST(newPostRequest({ body: "A fresh standalone post." }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deduped).toBe(false);
  });

  test("a retried create with the same body returns the existing draft, deduped: true", async () => {
    state.existingRow = {
      id: "already-created-1",
      title: "Old title",
      body: "Unchanged content.",
      meta: null,
      media_attachments: [],
      created_at: "2026-01-01",
    };

    const res = await POST(newPostRequest({ body: "Unchanged content." }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deduped).toBe(true);
    expect(data.draft.id).toBe("already-created-1");
  });

  test("scopes the rpc call to this workspace, passing body through untouched", async () => {
    await POST(newPostRequest({ body: "Some content for the board." }));
    expect(state.lastRpcArgs.p_workspace_id).toBe("ws1");
    expect(state.lastRpcArgs.p_body).toBe("Some content for the board.");
  });
});
