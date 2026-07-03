import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// POST/DELETE /api/drafts/[id]/schedule — the endpoint that turns a draft into
// a real, timed LinkedIn auto-publish. The route delegates to
// scheduleDraftPublish / cancelDraftPublish in lib/publishing, so this exercises
// the whole shared gate end-to-end: must be connected (409 not_connected),
// future-only (400), ≤3,000 chars (400), a BOARD-status draft (409), and cancel
// only while still 'scheduled' (409). requireWorkspaceId + supabaseAdmin are
// faked; the real helper logic runs.
// ---------------------------------------------------------------------------

vi.mock("@/lib/workspace", () => ({
  requireWorkspaceId: async () => "ws1",
  errorResponse: (e: unknown) =>
    Response.json({ ok: false, error: (e as Error).message ?? "err" }, { status: 500 }),
  NoWorkspaceError: class extends Error {},
}));

// State per test: the fake draft row + the fake connection row + a recorder for
// the update patch the shared helper writes to chat_artifacts.
type Row = Record<string, unknown>;
const state: {
  draft: Row | null;
  conn: Row | null;
  draftPatch: Row | null;
  deleteMatched: boolean; // did the guarded DELETE match a row?
} = { draft: null, conn: null, draftPatch: null, deleteMatched: true };

function makeClient() {
  function from(table: string) {
    const chain: Record<string, unknown> = {};
    let pending: Row | null = null; // pending update patch this chain will apply
    const ret = () => chain;
    Object.assign(chain, {
      select: ret,
      eq: ret,
      update: (patch: Row) => {
        pending = patch;
        return chain;
      },
      maybeSingle: async () => {
        // publishing_connections read (getConnection).
        if (table === "publishing_connections" && !pending) {
          return { data: state.conn, error: null };
        }
        // chat_artifacts read (scheduleDraftPublish's draft lookup).
        if (table === "chat_artifacts" && !pending) {
          return { data: state.draft, error: null };
        }
        // chat_artifacts update — record the patch. Two flavors:
        //   • schedule: no .select() maybeSingle on this path (POST awaits directly)
        //   • cancel:   .update().eq...eq...select().maybeSingle() returns affected
        if (table === "chat_artifacts" && pending) {
          state.draftPatch = pending;
          if ("schedule_status" in pending && pending.schedule_status === null) {
            // Cancel: matched-row semantics.
            return { data: state.deleteMatched ? { id: "d1" } : null, error: null };
          }
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
      // The POST's schedule update is awaited directly (no maybeSingle), so
      // resolve the awaitable to `{error:null}`. Recording the patch here too.
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        if (table === "chat_artifacts" && pending) {
          state.draftPatch = pending;
          resolve({ data: null, error: null });
          return;
        }
        resolve({ data: null, error: null });
      },
    });
    return chain;
  }
  return { from };
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => makeClient() }));

const { POST, DELETE } = await import("@/app/api/drafts/[id]/schedule/route");

function req(body?: unknown): Request {
  return new Request("http://t/api/drafts/d1/schedule", {
    method: body ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = { params: Promise.resolve({ id: "d1" }) };
const future = () => new Date(Date.now() + 3600_000).toISOString();

beforeEach(() => {
  state.draft = { id: "d1", body: "a short post", status: "drafting" };
  state.conn = { id: "c1", status: "active", zernio_account_id: "acct-1", zernio_profile_id: "prof-1" };
  state.draftPatch = null;
  state.deleteMatched = true;
});

describe("POST — schedule validation gate", () => {
  test("happy path → 200, commits the schedule AND syncs plan_to_post_on", async () => {
    const at = future();
    const res = await POST(req({ scheduledAt: at }), ctx);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(state.draftPatch).toMatchObject({
      schedule_status: "scheduled",
      scheduled_at: at,
      publish_attempts: 0,
    });
    expect(state.draftPatch!.plan_to_post_on).toBe(new Date(at).toISOString().slice(0, 10));
  });

  test("firstComment is persisted", async () => {
    await POST(req({ scheduledAt: future(), firstComment: "link https://x.com" }), ctx);
    expect(state.draftPatch!.first_comment).toBe("link https://x.com");
  });

  test("accepts a valid offset ISO (not just Z) — no over-strict Zod 400", async () => {
    // A year out so it's always future. +02:00 == 06:00Z.
    const res = await POST(req({ scheduledAt: "2099-07-04T08:00:00+02:00" }), ctx);
    expect(res.status).toBe(200);
    expect(state.draftPatch!.scheduled_at).toBe("2099-07-04T06:00:00.000Z");
  });

  test("rescheduling WITHOUT a firstComment field leaves first_comment untouched (no wipe)", async () => {
    await POST(req({ scheduledAt: future() }), ctx); // no firstComment key
    expect(state.draftPatch).not.toHaveProperty("first_comment");
  });

  test("not connected → 409 { reason: not_connected }, nothing written", async () => {
    state.conn = { status: "disconnected", zernio_account_id: "acct-1" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.reason).toBe("not_connected");
    expect(state.draftPatch).toBeNull();
  });

  test("a past time → 400, nothing written", async () => {
    const res = await POST(req({ scheduledAt: new Date(Date.now() - 3600_000).toISOString() }), ctx);
    expect(res.status).toBe(400);
    expect(state.draftPatch).toBeNull();
  });

  test("body over LinkedIn's 3,000-char cap → 400 with the overage, nothing written", async () => {
    state.draft = { id: "d1", body: "x".repeat(3050), status: "ready" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/50 characters/);
    expect(state.draftPatch).toBeNull();
  });

  test("a pending_review draft → 409 (approve first; review gate stays sovereign)", async () => {
    state.draft = { id: "d1", body: "ok", status: "pending_review" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    expect(res.status).toBe(409);
    expect(state.draftPatch).toBeNull();
  });

  test("a rejected draft → 409 too", async () => {
    state.draft = { id: "d1", body: "ok", status: "rejected" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    expect(res.status).toBe(409);
  });

  test("draft not found → 404", async () => {
    state.draft = null;
    const res = await POST(req({ scheduledAt: future() }), ctx);
    expect(res.status).toBe(404);
  });
});

describe("DELETE — cancel", () => {
  test("cancels a scheduled draft → 200, clears the schedule fields", async () => {
    const res = await DELETE(req(), ctx);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(state.draftPatch).toMatchObject({ schedule_status: null, scheduled_at: null });
  });

  test("nothing to cancel (already publishing/published) → 409", async () => {
    state.deleteMatched = false;
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(409);
  });
});
