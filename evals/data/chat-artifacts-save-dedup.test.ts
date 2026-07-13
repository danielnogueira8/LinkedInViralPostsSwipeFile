import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/chats/[id]/artifacts — save-to-board dedup. Re-saving a draft
// that hasn't changed since its last save used to insert a fresh
// chat_artifacts row EVERY time (no dedup check at all), so a user who
// clicked Save repeatedly on the same unedited content got N duplicate
// board entries. This is the server-side backstop (belt-and-suspenders
// alongside the client's own "Save" button disabling once saved+unchanged):
// if THIS chat already saved a board row with this EXACT body, return that
// row instead of inserting a duplicate.
//
// Scoped to (chat_id, workspace_id, body) — NOT workspace-wide — so two
// chats independently drafting identical wording are never treated as a
// dup; only re-saving the SAME chat's own already-saved content is.
// ---------------------------------------------------------------------------

const state: {
  chatRow: Record<string, unknown> | null;
  existingRow: Record<string, unknown> | null;
  insertResult: Record<string, unknown> | null;
  lastExistingFilters: Record<string, unknown>;
  lastRpcArgs: Record<string, unknown>;
  insertCalled: boolean;
} = {
  chatRow: { id: "chat1" },
  existingRow: null,
  insertResult: { id: "new-art", title: "T", body: "B", meta: null, media_attachments: [], created_at: "2026-01-01" },
  lastExistingFilters: {},
  lastRpcArgs: {},
  insertCalled: false,
};

const fakeRaw = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name !== "save_chat_draft") throw new Error(`unexpected rpc ${name}`);
    state.lastRpcArgs = args;
    if (!state.chatRow) {
      return { data: { outcome: "chat_not_found" }, error: null };
    }
    const deduped = Boolean(state.existingRow);
    state.insertCalled = !deduped;
    const source = (state.existingRow ?? state.insertResult) as Record<string, unknown>;
    return {
      data: {
        outcome: deduped ? "deduped" : "saved",
        draft: {
          kind: "post",
          status: "drafting",
          plan_to_post_on: null,
          chat_id: args.p_chat_id,
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
  from: (table: string) => {
    if (table === "chats") {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: state.chatRow, error: null }),
      });
      return chain;
    }
    if (table === "chat_artifacts") {
      let isInsert = false;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (!isInsert) state.lastExistingFilters[col] = val;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: state.existingRow, error: null }),
        insert: () => {
          isInsert = true;
          state.insertCalled = true;
          return chain;
        },
        single: async () => ({ data: state.insertResult, error: null }),
      });
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws1", raw: fakeRaw }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "u1" }) }));

const { POST } = await import("@/app/api/chats/[id]/artifacts/route");
const ctx = { params: Promise.resolve({ id: "chat1" }) };

function saveRequest(body: Record<string, unknown>): Request {
  return new Request("http://t/api/chats/chat1/artifacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.chatRow = { id: "chat1" };
  state.existingRow = null;
  state.lastExistingFilters = {};
  state.lastRpcArgs = {};
  state.insertCalled = false;
});

describe("POST /api/chats/[id]/artifacts — save dedup", () => {
  test("first save of new content: no existing row found, inserts normally", async () => {
    const res = await POST(saveRequest({ body: "A fresh draft body." }), ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(state.insertCalled).toBe(true);
    expect(data.deduped).toBeUndefined();
  });

  test("re-saving the SAME chat's already-saved, unchanged body returns the existing row, no insert", async () => {
    state.existingRow = {
      id: "already-saved-1",
      title: "Old title",
      body: "Unchanged content.",
      meta: null,
      media_attachments: [],
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const res = await POST(saveRequest({ body: "Unchanged content." }), ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deduped).toBe(true);
    expect(data.artifact.id).toBe("already-saved-1");
    expect(state.insertCalled).toBe(false);
  });

  test("the existence check is scoped to THIS chat and workspace", async () => {
    await POST(saveRequest({ body: "Some content." }), ctx);
    expect(state.lastRpcArgs.p_chat_id).toBe("chat1");
    expect(state.lastRpcArgs.p_workspace_id).toBe("ws1");
    expect(state.lastRpcArgs.p_body).toBe("Some content.");
  });

  test("edited content (different body) is NOT deduped — inserts as new", async () => {
    state.existingRow = null; // no row matches the NEW body exactly
    const res = await POST(saveRequest({ body: "Edited content, different from before." }), ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deduped).toBeUndefined();
    expect(state.insertCalled).toBe(true);
  });
});
