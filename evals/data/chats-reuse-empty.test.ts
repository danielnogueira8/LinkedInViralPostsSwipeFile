import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/chats — reuseEmpty guard. "New session" persists the session on
// click now, so repeated clicks would stack identical empty rows without this:
// when reuseEmpty is set and an existing non-archived "New chat" has ZERO
// messages, that row is returned (reused: true) instead of inserting another.
// Opt-in: a plain POST (model-source handoff, lazy create) must NEVER reuse.
// ---------------------------------------------------------------------------

const state: {
  candidate: Record<string, unknown> | null;
  firstMessage: Record<string, unknown> | null;
  insertCalled: boolean;
  candidateFilters: Record<string, unknown>;
} = {
  candidate: null,
  firstMessage: null,
  insertCalled: false,
  candidateFilters: {},
};

const INSERTED = {
  id: "fresh-1",
  title: "New chat",
  created_at: "2026-07-11T00:00:00Z",
  updated_at: "2026-07-11T00:00:00Z",
};

const fakeRaw = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {};
    if (table === "chats") {
      let isInsert = false;
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (!isInsert) state.candidateFilters[col] = val;
          return chain;
        },
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: state.candidate, error: null }),
        insert: () => {
          isInsert = true;
          state.insertCalled = true;
          return chain;
        },
        single: async () => ({ data: INSERTED, error: null }),
      });
      return chain;
    }
    if (table === "chat_messages") {
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: state.firstMessage, error: null }),
      });
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws1", raw: fakeRaw }),
}));

const { POST } = await import("@/app/api/chats/route");

function postRequest(body?: string): Request {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = body;
  return new Request("http://t/api/chats", {
    ...init,
  });
}

function post(body?: Record<string, unknown>): Request {
  return postRequest(body === undefined ? undefined : JSON.stringify(body));
}

function postRaw(body: string): Request {
  return postRequest(body);
}

beforeEach(() => {
  state.candidate = null;
  state.firstMessage = null;
  state.insertCalled = false;
  state.candidateFilters = {};
});

describe("POST /api/chats — reuseEmpty", () => {
  test("reuses an existing empty 'New chat' instead of inserting", async () => {
    state.candidate = { id: "empty-1", title: "New chat", created_at: "x", updated_at: "x" };
    state.firstMessage = null; // zero messages
    const res = await POST(post({ reuseEmpty: true }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.reused).toBe(true);
    expect(data.chat.id).toBe("empty-1");
    expect(state.insertCalled).toBe(false);
    // Candidate lookup is workspace-scoped and title-pinned.
    expect(state.candidateFilters.workspace_id).toBe("ws1");
    expect(state.candidateFilters.title).toBe("New chat");
  });

  test("a 'New chat' that HAS messages is not reused — inserts fresh", async () => {
    state.candidate = { id: "titled-fail-1", title: "New chat", created_at: "x", updated_at: "x" };
    state.firstMessage = { id: "m1" }; // auto-titling failed but the chat was used
    const res = await POST(post({ reuseEmpty: true }));
    const data = await res.json();
    expect(data.reused).toBeUndefined();
    expect(data.chat.id).toBe("fresh-1");
    expect(state.insertCalled).toBe(true);
  });

  test("no empty candidate → inserts fresh", async () => {
    const res = await POST(post({ reuseEmpty: true }));
    const data = await res.json();
    expect(data.reused).toBeUndefined();
    expect(state.insertCalled).toBe(true);
  });

  test("plain POST (no reuseEmpty) never reuses, even when an empty chat exists", async () => {
    state.candidate = { id: "empty-1", title: "New chat", created_at: "x", updated_at: "x" };
    state.firstMessage = null;
    const res = await POST(post({}));
    const data = await res.json();
    expect(data.reused).toBeUndefined();
    expect(data.chat.id).toBe("fresh-1");
    expect(state.insertCalled).toBe(true);
  });

  test("a POST with no body creates a chat for the Cowork handoff", async () => {
    const res = await POST(post());
    const data = await res.json();
    expect(data.error).not.toBe("Invalid input: expected object, received null");
    expect(data.ok).toBe(true);
    expect(data.chat.id).toBe("fresh-1");
    expect(state.insertCalled).toBe(true);
  });

  test("a whitespace-only body remains invalid JSON", async () => {
    const res = await POST(postRaw(" \n"));
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(state.insertCalled).toBe(false);
  });
});
