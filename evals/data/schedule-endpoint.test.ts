import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// POST/DELETE /api/drafts/[id]/schedule — turn a draft into a real, timed
// LinkedIn auto-publish. This pins the validation gate (the security-relevant
// part): must be connected, future-only, ≤3,000 chars, a BOARD-status draft
// (never a pending_review draft — the review gate stays sovereign), and cancel
// only while still 'scheduled'. On success it commits the schedule AND syncs
// plan_to_post_on. scopedSupabase + lib/publishing are faked.
// ---------------------------------------------------------------------------

// Configurable per test: the draft row the handler loads, and a recorder for
// the update patch the handler writes.
const state: {
  draft: { id: string; body: string; status: string; media_attachments?: unknown } | null;
  update: Record<string, unknown> | null;
  deleteResult: { id: string } | null; // what the DELETE .select().maybeSingle() returns
} = { draft: null, update: null, deleteResult: null };

const fakeRaw = {
  from: () => {
    const chain: Record<string, unknown> = {};
    const ret = () => chain;
    Object.assign(chain, {
      select: ret,
      eq: ret,
      update: (patch: Record<string, unknown>) => {
        state.update = patch;
        return chain;
      },
      maybeSingle: async () => {
        // The POST loads the draft; the DELETE's update().select().maybeSingle()
        // returns the affected row (or null when nothing matched).
        if (state.update && "schedule_status" in state.update && state.update.schedule_status === null) {
          return { data: state.deleteResult, error: null };
        }
        return { data: state.draft, error: null };
      },
    });
    return chain;
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws1", raw: fakeRaw }),
}));

const connRef: { current: unknown } = { current: { status: "active", zernio_account_id: "acct-1" } };
vi.mock("@/lib/publishing", () => ({
  getConnection: async () => connRef.current,
  // Real gate logic: active + has an account id.
  canPublish: (c: { status?: string; zernio_account_id?: string | null } | null) =>
    !!c && c.status === "active" && !!c.zernio_account_id,
}));

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
  state.draft = { id: "d1", body: "a short post", status: "drafting", media_attachments: [] };
  state.update = null;
  state.deleteResult = { id: "d1" };
  connRef.current = { status: "active", zernio_account_id: "acct-1" };
});

describe("POST — schedule validation gate", () => {
  test("happy path → 200, commits the schedule AND syncs plan_to_post_on", async () => {
    const at = future();
    const res = await POST(req({ scheduledAt: at }), ctx);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(state.update).toMatchObject({
      schedule_status: "scheduled",
      scheduled_at: at,
      publish_attempts: 0,
    });
    // plan_to_post_on synced to the date part so the calendar shows it.
    expect(state.update!.plan_to_post_on).toBe(new Date(at).toISOString().slice(0, 10));
  });

  test("firstComment is persisted", async () => {
    await POST(req({ scheduledAt: future(), firstComment: "link https://x.com" }), ctx);
    expect(state.update!.first_comment).toBe("link https://x.com");
  });

  test("not connected → 409 { reason: not_connected }, nothing written", async () => {
    connRef.current = { status: "disconnected", zernio_account_id: "acct-1" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.reason).toBe("not_connected");
    expect(state.update).toBeNull();
  });

  test("a past time → 400, nothing written", async () => {
    const res = await POST(req({ scheduledAt: new Date(Date.now() - 3600_000).toISOString() }), ctx);
    expect(res.status).toBe(400);
    expect(state.update).toBeNull();
  });

  test("body over LinkedIn's 3,000-char cap → 400 with the overage, nothing written", async () => {
    state.draft = { id: "d1", body: "x".repeat(3050), status: "ready" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/50 characters/); // 3050 - 3000
    expect(state.update).toBeNull();
  });

  test("a pending_review draft → 409 (approve first; review gate stays sovereign)", async () => {
    state.draft = { id: "d1", body: "ok", status: "pending_review" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    expect(res.status).toBe(409);
    expect(state.update).toBeNull();
  });

  test("a rejected draft → 409 too", async () => {
    state.draft = { id: "d1", body: "ok", status: "rejected" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    expect(res.status).toBe(409);
  });

  test("an already-posted draft → 409, nothing written", async () => {
    state.draft = { id: "d1", body: "ok", status: "posted" };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    expect(res.status).toBe(409);
    expect(state.update).toBeNull();
  });

  test("draft not found → 404", async () => {
    state.draft = null;
    const res = await POST(req({ scheduledAt: future() }), ctx);
    expect(res.status).toBe(404);
  });

  test("invalid media attachments → 400, nothing written", async () => {
    state.draft = {
      id: "d1",
      body: "ok",
      status: "ready",
      media_attachments: [
        {
          id: "m1",
          name: "photo.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          type: "image",
          url: "not-a-url",
          uploadedAt: new Date().toISOString(),
        },
      ],
    };
    const res = await POST(req({ scheduledAt: future() }), ctx);
    expect(res.status).toBe(400);
    expect(state.update).toBeNull();
  });

  test("media schedule beyond Zernio's 7-day temp window → 400", async () => {
    state.draft = {
      id: "d1",
      body: "ok",
      status: "ready",
      media_attachments: [
        {
          id: "m1",
          name: "photo.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          type: "image",
          url: "https://media.zernio.com/temp/photo.jpg",
          uploadedAt: new Date().toISOString(),
        },
      ],
    };
    const inEightDays = new Date(Date.now() + 8 * 24 * 3600_000).toISOString();
    const res = await POST(req({ scheduledAt: inEightDays }), ctx);
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/within 7 days/i);
    expect(state.update).toBeNull();
  });

  test("library media can be scheduled beyond Zernio's 7-day temp window", async () => {
    state.draft = {
      id: "d1",
      body: "ok",
      status: "ready",
      media_attachments: [
        {
          id: "asset:a1",
          source: "library",
          assetId: "a1",
          name: "photo.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          type: "image",
          storageBucket: "media-assets",
          storagePath: "ws/photo.jpg",
          uploadedAt: new Date().toISOString(),
        },
      ],
    };
    const inEightDays = new Date(Date.now() + 8 * 24 * 3600_000).toISOString();
    const res = await POST(req({ scheduledAt: inEightDays }), ctx);
    expect(res.status).toBe(200);
    expect(state.update).toMatchObject({ schedule_status: "scheduled" });
  });
});

describe("DELETE — cancel", () => {
  test("cancels a scheduled draft → 200, clears the schedule fields", async () => {
    const res = await DELETE(req(), ctx);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(state.update).toMatchObject({ schedule_status: null, scheduled_at: null });
  });

  test("nothing to cancel (already publishing/published) → 409", async () => {
    state.deleteResult = null; // the guarded update matched no row
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(409);
  });
});
