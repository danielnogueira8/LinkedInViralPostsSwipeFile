import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Persistence guards on chat_messages.artifacts. PATCH uses the CAS column
// from migration-076. DELETE uses migration-094's one-statement command so a
// stable id reused by an in-place refine is removed from every transcript row
// atomically while still incrementing each owner's CAS version.
// ---------------------------------------------------------------------------

const state: {
  chatRow: Record<string, unknown> | null;
  messageRows: Record<string, unknown>[];
  writeSucceeds: boolean;
  lastUpdatePatch: Record<string, unknown> | null;
  lastVersionFilter: number | null;
  lastRpc: { name: string; params: Record<string, unknown> } | null;
  updateCalls: Array<{
    id: string | null;
    patch: Record<string, unknown>;
    version: number | null;
  }>;
  lastOrder: { column: string; ascending: boolean } | null;
  recordedEdits: Array<Record<string, unknown>>;
} = {
  chatRow: { id: "chat1" },
  messageRows: [],
  writeSucceeds: true,
  lastUpdatePatch: null,
  lastVersionFilter: null,
  lastRpc: null,
  updateCalls: [],
  lastOrder: null,
  recordedEdits: [],
};

const fakeRaw = {
  rpc: async (name: string, params: Record<string, unknown>) => {
    state.lastRpc = { name, params };
    let removed = 0;
    for (const row of state.messageRows) {
      const artifacts = row.artifacts;
      if (!Array.isArray(artifacts)) continue;
      const next = artifacts.filter(
        (artifact) =>
          (artifact as { id?: unknown })?.id !== params.p_artifact_id,
      );
      if (next.length === artifacts.length) continue;
      row.artifacts = next.length ? next : null;
      row.artifacts_version = Number(row.artifacts_version) + 1;
      removed += 1;
    }
    return { data: removed, error: null };
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
    if (table === "chat_messages") {
      let isWrite = false;
      const updateCall: {
        id: string | null;
        patch: Record<string, unknown>;
        version: number | null;
      } = { id: null, patch: {}, version: null };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (isWrite && col === "id") updateCall.id = val as string;
          if (isWrite && col === "artifacts_version") {
            state.lastVersionFilter = val as number;
            updateCall.version = val as number;
          }
          return chain;
        },
        not: () => chain,
        order: (column: string, options: { ascending: boolean }) => {
          state.lastOrder = { column, ascending: options.ascending };
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          isWrite = true;
          state.lastUpdatePatch = patch;
          updateCall.patch = patch;
          state.updateCalls.push(updateCall);
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
vi.mock("@/lib/draft-edit-events", () => ({
  recordDraftEditEvent: async (input: Record<string, unknown>) => {
    state.recordedEdits.push(input);
  },
}));

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
  state.lastRpc = null;
  state.updateCalls = [];
  state.lastOrder = null;
  state.recordedEdits = [];
});

describe("DELETE /api/chats/[id]/artifacts — atomic stable-id removal", () => {
  test("normal delete uses the workspace-scoped atomic transcript command", async () => {
    const res = await DELETE(deleteRequest("art-a"), ctx);
    expect(res.status).toBe(200);
    expect(state.lastRpc).toEqual({
      name: "delete_chat_message_artifact",
      params: {
        p_workspace_id: "ws1",
        p_chat_id: "chat1",
        p_artifact_id: "art-a",
      },
    });
    expect(state.messageRows[0]).toMatchObject({
      artifacts: [{ id: "art-b", kind: "post", body: "Post B" }],
      artifacts_version: 4,
    });
  });

  test("deleting an id that isn't present anywhere is still idempotent (no write attempted)", async () => {
    const res = await DELETE(deleteRequest("nonexistent"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(false);
    expect(state.lastRpc).not.toBeNull();
  });

  test("deletes every persisted owner of a reused in-place-refine id", async () => {
    state.messageRows = [
      {
        id: "msg-original",
        artifacts_version: 3,
        artifacts: [
          { id: "art-a", kind: "post", body: "Original" },
          { id: "sibling-a", kind: "hook", body: "Hook" },
        ],
      },
      {
        id: "msg-refined",
        artifacts_version: 7,
        artifacts: [
          { id: "art-a", kind: "post", body: "Refined" },
          { id: "sibling-b", kind: "post", body: "Other post" },
        ],
      },
    ];

    const res = await DELETE(deleteRequest("art-a"), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, removed: true });
    expect(state.messageRows).toEqual([
      expect.objectContaining({
        id: "msg-original",
        artifacts: [{ id: "sibling-a", kind: "hook", body: "Hook" }],
        artifacts_version: 4,
      }),
      expect.objectContaining({
        id: "msg-refined",
        artifacts: [
          { id: "sibling-b", kind: "post", body: "Other post" },
        ],
        artifacts_version: 8,
      }),
    ]);
    expect(
      state.messageRows.flatMap((row) =>
        Array.isArray(row.artifacts) ? row.artifacts : [],
      ),
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "art-a" })]),
    );
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
    expect(state.lastOrder).toEqual({
      column: "created_at",
      ascending: false,
    });
    expect(state.recordedEdits).toEqual([
      expect.objectContaining({
        artifactId: "art-a",
        beforeBody: "Post A",
        afterBody: "Edited body",
      }),
    ]);
  });

  test("edits only the newest authoritative copy of a reused Artifact id", async () => {
    state.messageRows = [
      {
        id: "msg-newest",
        artifacts_version: 7,
        artifacts: [{ id: "art-a", kind: "post", body: "Latest refinement" }],
      },
      {
        id: "msg-oldest",
        artifacts_version: 3,
        artifacts: [{ id: "art-a", kind: "post", body: "Original" }],
      },
    ];

    const res = await PATCH(
      patchRequest({ targetId: "art-a", body: "User edit" }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]).toMatchObject({
      id: "msg-newest",
      version: 7,
    });
    expect(state.recordedEdits).toEqual([
      expect.objectContaining({
        beforeBody: "Latest refinement",
        afterBody: "User edit",
      }),
    ]);
  });

  test("a repeated newest body never rewrites an older reused id", async () => {
    state.messageRows = [
      {
        id: "msg-newest",
        artifacts_version: 7,
        artifacts: [{ id: "art-a", kind: "post", body: "Same body" }],
      },
      {
        id: "msg-oldest",
        artifacts_version: 3,
        artifacts: [{ id: "art-a", kind: "post", body: "Old body" }],
      },
    ];

    const res = await PATCH(
      patchRequest({ targetId: "art-a", body: "Same body" }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: true });
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]).toMatchObject({
      id: "msg-newest",
      version: 7,
    });
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
