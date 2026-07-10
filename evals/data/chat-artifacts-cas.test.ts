import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// CAS guard on chat_messages.artifacts (db/migration-076). DELETE and PATCH
// both do a read-then-write on the jsonb artifacts array; two concurrent
// requests on cards in the SAME message (delete card A while editing card B
// in another tab) used to silently clobber each other with no error. Now
// both writes are gated on artifacts_version, checked via a 0-row-result ->
// 409, matching the compare-at-write pattern already used for
// chat_artifacts.schedule_status.
// ---------------------------------------------------------------------------

const state: {
  chatRow: Record<string, unknown> | null;
  messageRows: Record<string, unknown>[];
  writeSucceeds: boolean;
  lastUpdatePatch: Record<string, unknown> | null;
  lastVersionFilter: number | null;
} = {
  chatRow: { id: "chat1" },
  messageRows: [],
  writeSucceeds: true,
  lastUpdatePatch: null,
  lastVersionFilter: null,
};

const fakeRaw = {
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
    if (table === "chat_messages") {
      let isWrite = false;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (isWrite && col === "artifacts_version") state.lastVersionFilter = val as number;
          return chain;
        },
        not: () => chain,
        update: (patch: Record<string, unknown>) => {
          isWrite = true;
          state.lastUpdatePatch = patch;
          return chain;
        },
        maybeSingle: async () => ({
          data: isWrite && state.writeSucceeds ? { id: "msg1" } : null,
          error: null,
        }),
        then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => unknown) =>
          resolve({ data: state.messageRows, error: null }),
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

const { DELETE, PATCH } = await import("@/app/api/chats/[id]/artifacts/route");
const ctx = { params: Promise.resolve({ id: "chat1" }) };

function deleteRequest(artifactId: string): Request {
  return new Request("http://t/api/chats/chat1/artifacts", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifactId }),
  });
}

function patchRequest(body: Record<string, unknown>): Request {
  return new Request("http://t/api/chats/chat1/artifacts", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.chatRow = { id: "chat1" };
  state.messageRows = [
    {
      id: "msg1",
      artifacts_version: 3,
      artifacts: [
        { id: "art-a", kind: "post", body: "Post A" },
        { id: "art-b", kind: "post", body: "Post B" },
      ],
    },
  ];
  state.writeSucceeds = true;
  state.lastUpdatePatch = null;
  state.lastVersionFilter = null;
});

describe("DELETE /api/chats/[id]/artifacts — CAS guard", () => {
  test("normal delete: filters on the version it just read, increments it", async () => {
    const res = await DELETE(deleteRequest("art-a"), ctx);
    expect(res.status).toBe(200);
    expect(state.lastVersionFilter).toBe(3);
    expect(state.lastUpdatePatch).toMatchObject({ artifacts_version: 4 });
    const remaining = (state.lastUpdatePatch!.artifacts as Array<{ id: string }>) ?? [];
    expect(remaining.map((a) => a.id)).toEqual(["art-b"]);
  });

  test("a concurrent write already bumped the version -> 409, not a silent clobber", async () => {
    state.writeSucceeds = false; // simulates someone else's write landing first
    const res = await DELETE(deleteRequest("art-a"), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/changed elsewhere/i);
  });

  test("deleting an id that isn't present anywhere is still idempotent (no write attempted)", async () => {
    const res = await DELETE(deleteRequest("nonexistent"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(false);
    expect(state.lastUpdatePatch).toBeNull();
  });
});

describe("PATCH /api/chats/[id]/artifacts — CAS guard", () => {
  test("normal edit: filters on the version it just read, increments it", async () => {
    const res = await PATCH(
      patchRequest({ targetId: "art-a", body: "Edited body" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(state.lastVersionFilter).toBe(3);
    expect(state.lastUpdatePatch).toMatchObject({ artifacts_version: 4 });
  });

  test("a concurrent write already bumped the version -> 409, edit not silently dropped", async () => {
    state.writeSucceeds = false;
    const res = await PATCH(
      patchRequest({ targetId: "art-a", body: "Edited body" }),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/changed elsewhere/i);
  });

  test("target not found anywhere -> 404, distinct from a version conflict", async () => {
    const res = await PATCH(
      patchRequest({ targetId: "nonexistent", body: "x" }),
      ctx,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found yet/i);
  });
});
