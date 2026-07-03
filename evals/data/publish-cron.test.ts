import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The LinkedIn publisher (publishDueDrafts in lib/publishing.ts), run by the
// /api/cron/publish-scheduled cron. Pins the load-bearing behavior:
//   • each due row is CLAIMED atomically (scheduled→publishing) before any
//     Zernio call, so a second run can't double-post (the TOCTOU guard);
//   • success → 'published' + zernio_post_id + board status flipped to 'posted';
//   • a 422 duplicate → 'failed', NEVER retried;
//   • a transient failure → back to 'scheduled' to retry, until the attempt cap;
//   • token-expiry → the connection is flipped to disconnected;
//   • a missing/inactive connection → 'failed' with a reconnect message.
// A tiny stateful fake DB models chat_artifacts + publishing_connections;
// createLinkedInPost is stubbed per test.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const db: { drafts: Row[]; conns: Row[] } = { drafts: [], conns: [] };

// A minimal query builder over the in-memory tables: supports the exact chains
// publishDueDrafts uses (select/eq/lte/order/limit, update/eq/select/maybeSingle).
function makeClient() {
  function from(table: "chat_artifacts" | "publishing_connections") {
    const rows = () => (table === "chat_artifacts" ? db.drafts : db.conns);
    const filters: Array<[string, unknown]> = [];
    let lteFilter: [string, unknown] | null = null;
    let pendingUpdate: Row | null = null;
    let limitN = Infinity;

    const match = (r: Row) =>
      filters.every(([k, v]) => r[k] === v) &&
      (!lteFilter || (r[lteFilter[0]] as string) <= (lteFilter[1] as string));

    const applyUpdate = (): Row[] => {
      const hit = rows().filter(match);
      for (const r of hit) Object.assign(r, pendingUpdate);
      return hit;
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return builder;
      },
      lte: (k: string, v: unknown) => {
        lteFilter = [k, v];
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      update: (patch: Row) => {
        pendingUpdate = patch;
        return builder;
      },
      maybeSingle: async () => {
        if (pendingUpdate) {
          const hit = applyUpdate();
          return { data: hit[0] ?? null, error: null };
        }
        const hit = rows().filter(match);
        return { data: hit[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        if (pendingUpdate) {
          const hit = applyUpdate();
          return resolve({ data: hit, error: null });
        }
        return resolve({ data: rows().filter(match).slice(0, limitN), error: null });
      },
    };
    return builder;
  }
  return { from };
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => makeClient() }));

const publishSpy = vi.fn();
vi.mock("@/lib/zernio", () => ({
  createLinkedInPost: (...a: unknown[]) => publishSpy(...a),
  logZernioUsage: async () => undefined,
  // getConnection/canPublish live in publishing.ts and read the fake conns table.
}));

const { publishDueDrafts } = await import("@/lib/publishing");

const NOW = "2026-07-03T12:00:00.000Z";
const PAST = "2026-07-03T11:00:00.000Z";

function seedConnection(active = true) {
  db.conns = [
    {
      id: "c1",
      workspace_id: "ws1",
      network: "linkedin",
      zernio_profile_id: "prof-1",
      zernio_account_id: active ? "acct-1" : null,
      status: active ? "active" : "disconnected",
      display_name: "Jane",
      avatar_url: null,
      account_type: "personal",
      disconnected_reason: null,
    },
  ];
}
function seedDueDraft(over: Row = {}) {
  db.drafts = [
    {
      id: "d1",
      workspace_id: "ws1",
      body: "hello world",
      status: "ready",
      first_comment: null,
      schedule_status: "scheduled",
      scheduled_at: PAST,
      publish_attempts: 0,
      publish_error: null,
      zernio_post_id: null,
      published_at: null,
      ...over,
    },
  ];
}
const draft = () => db.drafts[0];
const conn = () => db.conns[0];

beforeEach(() => {
  db.drafts = [];
  db.conns = [];
  publishSpy.mockReset();
  publishSpy.mockResolvedValue({ ok: true, postId: "post-123" });
});

describe("publishDueDrafts", () => {
  test("a due draft publishes → 'published' + post id + board status 'posted'", async () => {
    seedConnection();
    seedDueDraft();
    const summary = await publishDueDrafts(NOW);
    expect(summary).toEqual({ due: 1, published: 1, failed: 0 });
    expect(draft().schedule_status).toBe("published");
    expect(draft().zernio_post_id).toBe("post-123");
    expect(draft().status).toBe("posted"); // moved to the Posted column
    // Published with the workspace's resolved account id (never client input).
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-1", content: "hello world" }),
    );
  });

  test("only DUE rows are picked (future schedules are skipped)", async () => {
    seedConnection();
    db.drafts = [
      { id: "future", workspace_id: "ws1", body: "later", status: "ready", first_comment: null, schedule_status: "scheduled", scheduled_at: "2026-07-03T23:00:00.000Z", publish_attempts: 0 },
    ];
    const summary = await publishDueDrafts(NOW);
    expect(summary.due).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("claim is atomic: a row already 'publishing' is not re-published", async () => {
    seedConnection();
    seedDueDraft({ schedule_status: "publishing" }); // already claimed
    const summary = await publishDueDrafts(NOW);
    // The initial due-scan filters schedule_status='scheduled', so it's not even
    // selected — but this pins that a non-scheduled row is never published.
    expect(summary.due).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("a 422 duplicate → 'failed', NEVER retried", async () => {
    seedConnection();
    seedDueDraft();
    publishSpy.mockResolvedValue({
      ok: false,
      error: { kind: "duplicate", status: 422, message: "duplicate of an earlier post" },
    });
    const summary = await publishDueDrafts(NOW);
    expect(summary).toEqual({ due: 1, published: 0, failed: 1 });
    expect(draft().schedule_status).toBe("failed"); // not back to 'scheduled'
    expect(String(draft().publish_error)).toMatch(/duplicate/i);
  });

  test("a transient failure → back to 'scheduled' to retry (under the attempt cap)", async () => {
    seedConnection();
    seedDueDraft({ publish_attempts: 0 });
    publishSpy.mockResolvedValue({
      ok: false,
      error: { kind: "transient", status: 503, message: "temporary" },
    });
    const summary = await publishDueDrafts(NOW);
    expect(summary.failed).toBe(0); // not terminal yet
    expect(draft().schedule_status).toBe("scheduled"); // will retry next tick
    expect(draft().publish_attempts).toBe(1);
  });

  test("a transient failure at the attempt cap → 'failed' (stops retrying)", async () => {
    seedConnection();
    seedDueDraft({ publish_attempts: 2 }); // this is the 3rd attempt
    publishSpy.mockResolvedValue({
      ok: false,
      error: { kind: "transient", status: 503, message: "temporary" },
    });
    const summary = await publishDueDrafts(NOW);
    expect(summary.failed).toBe(1);
    expect(draft().schedule_status).toBe("failed");
    expect(draft().publish_attempts).toBe(3);
  });

  test("token-expiry → the connection is flipped to disconnected", async () => {
    seedConnection();
    seedDueDraft();
    publishSpy.mockResolvedValue({
      ok: false,
      error: { kind: "token_expired", status: 401, message: "expired" },
    });
    await publishDueDrafts(NOW);
    expect(conn().status).toBe("disconnected");
  });

  test("an inactive connection → 'failed' with a reconnect message, no Zernio call", async () => {
    seedConnection(false); // disconnected, no account id
    seedDueDraft();
    const summary = await publishDueDrafts(NOW);
    expect(summary.failed).toBe(1);
    expect(draft().schedule_status).toBe("failed");
    expect(String(draft().publish_error)).toMatch(/reconnect/i);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
