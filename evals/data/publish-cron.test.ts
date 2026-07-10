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
let beforeClaim: (() => void) | null = null;
let dbFailure:
  | "due_select"
  | "claim"
  | "media_update"
  | "publish_update"
  | "publish_missing"
  | null = null;

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
        if (
          dbFailure === "publish_update" &&
          table === "chat_artifacts" &&
          pendingUpdate?.schedule_status === "published"
        ) {
          return { data: null, error: new Error("publish state unavailable") };
        }
        if (
          dbFailure === "publish_missing" &&
          table === "chat_artifacts" &&
          pendingUpdate?.schedule_status === "published"
        ) {
          return { data: null, error: null };
        }
        if (
          dbFailure === "claim" &&
          table === "chat_artifacts" &&
          pendingUpdate?.schedule_status === "publishing"
        ) {
          return { data: null, error: new Error("claim unavailable") };
        }
        if (pendingUpdate) {
          if (
            table === "chat_artifacts" &&
            pendingUpdate.schedule_status === "publishing" &&
            beforeClaim
          ) {
            const mutate = beforeClaim;
            beforeClaim = null;
            mutate();
          }
          const hit = applyUpdate();
          return { data: hit[0] ?? null, error: null };
        }
        const hit = rows().filter(match);
        return { data: hit[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: unknown; error: Error | null }) => void) => {
        if (
          dbFailure === "due_select" &&
          table === "chat_artifacts" &&
          !pendingUpdate &&
          filters.some(([key, value]) => key === "schedule_status" && value === "scheduled")
        ) {
          return resolve({ data: null, error: new Error("due scan unavailable") });
        }
        if (
          dbFailure === "media_update" &&
          table === "chat_artifacts" &&
          Array.isArray(pendingUpdate?.media_attachments)
        ) {
          return resolve({ data: null, error: new Error("media state unavailable") });
        }
        if (pendingUpdate) {
          const hit = applyUpdate();
          return resolve({ data: hit, error: null });
        }
        return resolve({
          data: rows().filter(match).slice(0, limitN).map((row) => ({ ...row })),
          error: null,
        });
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

const { publishDueDrafts, stalePublishingCutoffIso } = await import(
  "@/lib/publishing"
);

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
      media_attachments: [],
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
  beforeClaim = null;
  dbFailure = null;
  publishSpy.mockResolvedValue({ ok: true, postId: "post-123" });
});

describe("publishDueDrafts", () => {
  test("a post rescheduled after the due scan is not claimed or published", async () => {
    seedConnection();
    seedDueDraft();
    beforeClaim = () => {
      draft().scheduled_at = "2026-07-03T23:00:00.000Z";
    };

    const summary = await publishDueDrafts(NOW);

    expect(summary).toEqual({ due: 1, published: 0, failed: 0, staleSwept: 0 });
    expect(draft().schedule_status).toBe("scheduled");
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("an edit after the due scan publishes the values returned by the claim", async () => {
    seedConnection();
    seedDueDraft();
    beforeClaim = () => {
      draft().body = "latest body";
      draft().first_comment = "latest comment";
    };

    await publishDueDrafts(NOW);

    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({ content: "latest body", firstComment: "latest comment" }),
    );
  });

  test("a due-query database error fails the run instead of reporting zero due posts", async () => {
    dbFailure = "due_select";

    await expect(publishDueDrafts(NOW)).rejects.toThrow("due scan unavailable");
  });

  test("a claim database error fails the run instead of silently skipping the post", async () => {
    seedConnection();
    seedDueDraft();
    dbFailure = "claim";

    await expect(publishDueDrafts(NOW)).rejects.toThrow("claim unavailable");
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("a post-success database error fails the run instead of reporting persisted success", async () => {
    seedConnection();
    seedDueDraft();
    dbFailure = "publish_update";

    await expect(publishDueDrafts(NOW)).rejects.toThrow("publish state unavailable");
    expect(publishSpy).toHaveBeenCalledOnce();
    expect(draft().schedule_status).toBe("publishing");
  });

  test("a zero-row post-success update does not report persisted success", async () => {
    seedConnection();
    seedDueDraft();
    dbFailure = "publish_missing";

    await expect(publishDueDrafts(NOW)).rejects.toThrow(
      "Published post state could not be persisted",
    );
    expect(publishSpy).toHaveBeenCalledOnce();
  });

  test("a media-state database error propagates instead of becoming a media validation failure", async () => {
    seedConnection();
    seedDueDraft({
      media_attachments: [
        {
          id: "m1",
          name: "photo.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          type: "image",
          url: "https://media.zernio.com/temp/photo.jpg",
          uploadedAt: "2026-07-03T10:00:00.000Z",
        },
      ],
    });
    dbFailure = "media_update";

    await expect(publishDueDrafts(NOW)).rejects.toThrow("media state unavailable");
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("a due draft publishes → 'published' + post id + board status 'posted'", async () => {
    seedConnection();
    seedDueDraft();
    const summary = await publishDueDrafts(NOW);
    expect(summary).toEqual({ due: 1, published: 1, failed: 0, staleSwept: 0 });
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
    // scheduled_at is RECENT (2 min before NOW) — inside the stale-sweep
    // window, so this row is claim-fresh, not orphaned. Isolates atomicity
    // from the stale-sweep behavior (covered separately below).
    seedDueDraft({
      schedule_status: "publishing",
      scheduled_at: "2026-07-03T11:58:00.000Z",
    });
    const summary = await publishDueDrafts(NOW);
    // The initial due-scan filters schedule_status='scheduled', so it's not even
    // selected — but this pins that a non-scheduled row is never published.
    expect(summary.due).toBe(0);
    expect(summary.staleSwept).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
    expect(draft().schedule_status).toBe("publishing"); // untouched, not swept
  });

  test("a 422 duplicate → 'failed', NEVER retried", async () => {
    seedConnection();
    seedDueDraft();
    publishSpy.mockResolvedValue({
      ok: false,
      error: { kind: "duplicate", status: 422, message: "duplicate of an earlier post" },
    });
    const summary = await publishDueDrafts(NOW);
    expect(summary).toEqual({ due: 1, published: 0, failed: 1, staleSwept: 0 });
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

  test("valid media attachments are sent as Zernio mediaItems", async () => {
    seedConnection();
    seedDueDraft({
      media_attachments: [
        {
          id: "m1",
          name: "photo.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          type: "image",
          url: "https://media.zernio.com/temp/photo.jpg",
          uploadedAt: "2026-07-03T10:00:00.000Z",
        },
      ],
    });
    await publishDueDrafts(NOW);
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaItems: [{ url: "https://media.zernio.com/temp/photo.jpg", type: "image" }],
      }),
    );
  });

  test("malformed media fails locally without calling Zernio", async () => {
    seedConnection();
    seedDueDraft({
      media_attachments: [
        {
          id: "m1",
          name: "photo.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          type: "image",
          url: "not-a-url",
          uploadedAt: "2026-07-03T10:00:00.000Z",
        },
      ],
    });
    const summary = await publishDueDrafts(NOW);
    expect(summary).toEqual({ due: 1, published: 0, failed: 1, staleSwept: 0 });
    expect(draft().schedule_status).toBe("failed");
    expect(String(draft().publish_error)).toMatch(/media/i);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stale-'publishing' sweep — the orphan-recovery fix. A row claimed
// (scheduled → publishing) but never reaching a terminal state (the claiming
// tick crashed/timed out) used to be stuck FOREVER: the due-query only ever
// selects 'scheduled' rows, and the unschedule route refuses anything that
// isn't 'scheduled', so the user couldn't even cancel it. The sweep runs
// before every tick's due-query and flips orphans to 'failed' (never back to
// 'scheduled', to avoid risking a double-post if the underlying LinkedIn post
// actually went out before the crash).
// ---------------------------------------------------------------------------
describe("stale 'publishing' sweep (orphan recovery)", () => {
  test("a 'publishing' row older than the threshold is swept to 'failed'", async () => {
    seedConnection();
    // Claimed well past scheduled_at, long before NOW minus the 10-min window —
    // this is the orphan: the claiming tick died and nothing ever revisits it.
    seedDueDraft({
      schedule_status: "publishing",
      scheduled_at: "2026-07-03T11:00:00.000Z", // 1 hour before NOW
    });
    const summary = await publishDueDrafts(NOW);
    expect(summary.staleSwept).toBe(1);
    expect(draft().schedule_status).toBe("failed"); // NOT back to 'scheduled'
    expect(String(draft().publish_error)).toMatch(/interrupted/i);
    // The swept row is terminal, so this tick's own due-query doesn't also
    // try to publish it.
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("a 'publishing' row INSIDE the threshold is left alone (still being worked)", async () => {
    seedConnection();
    seedDueDraft({
      schedule_status: "publishing",
      scheduled_at: "2026-07-03T11:58:00.000Z", // 2 min before NOW
    });
    const summary = await publishDueDrafts(NOW);
    expect(summary.staleSwept).toBe(0);
    expect(draft().schedule_status).toBe("publishing"); // untouched
  });

  test("the sweep runs BEFORE the due-query, so a swept row can't also publish this tick", async () => {
    seedConnection();
    seedDueDraft({
      schedule_status: "publishing",
      scheduled_at: "2026-07-03T11:00:00.000Z",
    });
    await publishDueDrafts(NOW);
    // If the sweep ran after (or not at all), a 'publishing' row wouldn't be
    // picked by the 'scheduled'-only due-query anyway — this pins the OUTCOME
    // (terminal 'failed', no publish attempt) rather than the ordering itself.
    expect(publishSpy).not.toHaveBeenCalled();
    expect(draft().schedule_status).toBe("failed");
  });

  test("a healthy 'scheduled' row (never claimed) is never swept", async () => {
    seedConnection();
    seedDueDraft({ schedule_status: "scheduled", scheduled_at: PAST });
    const summary = await publishDueDrafts(NOW);
    expect(summary.staleSwept).toBe(0);
    // Published normally — the sweep only ever touches 'publishing' rows.
    expect(draft().schedule_status).toBe("published");
  });

  test("stalePublishingCutoffIso computes the cutoff N minutes before now", () => {
    expect(stalePublishingCutoffIso("2026-07-03T12:00:00.000Z", 10)).toBe(
      "2026-07-03T11:50:00.000Z",
    );
    expect(stalePublishingCutoffIso("2026-07-03T12:00:00.000Z", 0)).toBe(
      "2026-07-03T12:00:00.000Z",
    );
    // Default threshold (10 min) matches the exported constant's behavior.
    expect(stalePublishingCutoffIso("2026-07-03T12:00:00.000Z")).toBe(
      "2026-07-03T11:50:00.000Z",
    );
  });
});
