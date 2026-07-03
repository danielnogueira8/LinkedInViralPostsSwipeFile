import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Agent tools schedule_publish + cancel_publish, plus the shared timezone
// resolver in lib/publishing. The tools let the user say things like "schedule
// this post for tomorrow noon" in chat; the resolver turns a local wall time +
// IANA timezone into a UTC instant DETERMINISTICALLY (never trusts the model
// to compute offsets), and the tool delegates to scheduleDraftPublish so the
// full validation gate — connection / future / ≤3,000 chars / board-status —
// is the SAME one the editor endpoint uses. Also pins that the two tools are
// registered in TOOL_FNS + TOOL_DEFS so GLM sees them.
// ---------------------------------------------------------------------------

// State per test (see schedule-endpoint.test.ts — same fake-DB shape).
type Row = Record<string, unknown>;
const state: {
  draft: Row | null;
  conn: Row | null;
  workspaceTimezone: string | null; // settings.default_timezone
  draftPatch: Row | null;
  deleteMatched: boolean;
} = { draft: null, conn: null, workspaceTimezone: null, draftPatch: null, deleteMatched: true };

function makeClient() {
  function from(table: string) {
    const chain: Record<string, unknown> = {};
    let pending: Row | null = null;
    const ret = () => chain;
    Object.assign(chain, {
      select: ret,
      eq: ret,
      update: (patch: Row) => {
        pending = patch;
        return chain;
      },
      maybeSingle: async () => {
        if (table === "publishing_connections" && !pending) return { data: state.conn, error: null };
        // getWorkspaceTimezone reads settings.default_timezone.
        if (table === "settings" && !pending) {
          return {
            data: state.workspaceTimezone ? { value: state.workspaceTimezone } : null,
            error: null,
          };
        }
        if (table === "chat_artifacts" && !pending) return { data: state.draft, error: null };
        if (table === "chat_artifacts" && pending) {
          state.draftPatch = pending;
          if ("schedule_status" in pending && pending.schedule_status === null) {
            return { data: state.deleteMatched ? { id: "d1" } : null, error: null };
          }
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
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

const { TOOL_FNS, TOOL_DEFS } = await import("@/lib/agent/tools");
const { resolveScheduleAt } = await import("@/lib/publishing");

beforeEach(() => {
  state.draft = { id: "d1", body: "a short post", status: "drafting" };
  state.conn = { id: "c1", status: "active", zernio_account_id: "acct-1", zernio_profile_id: "prof-1" };
  state.workspaceTimezone = null; // no default by default; individual tests set it
  state.draftPatch = null;
  state.deleteMatched = true;
});

describe("resolveScheduleAt — deterministic wall-time → UTC", () => {
  test("a full ISO instant with Z is used verbatim", () => {
    expect(resolveScheduleAt("2026-07-04T16:00:00Z")).toBe("2026-07-04T16:00:00.000Z");
  });

  test("a full ISO instant with a +HH:MM offset is used verbatim", () => {
    // 2026-07-04T18:00+02:00 == 16:00Z
    expect(resolveScheduleAt("2026-07-04T18:00:00+02:00")).toBe("2026-07-04T16:00:00.000Z");
  });

  test("a local wall time in Europe/Lisbon (BST) → the right UTC instant", () => {
    // July 4 is DST in Lisbon (WEST, UTC+1) → 12:00 local == 11:00Z.
    expect(resolveScheduleAt("2026-07-04T12:00", "Europe/Lisbon")).toBe("2026-07-04T11:00:00.000Z");
  });

  test("a local wall time in America/New_York (EDT) → the right UTC instant", () => {
    // July 4 is EDT (UTC-4) → 12:00 local == 16:00Z.
    expect(resolveScheduleAt("2026-07-04T12:00", "America/New_York")).toBe("2026-07-04T16:00:00.000Z");
  });

  test("a wall time with NO timezone → null (never guess — 'tomorrow noon' is ambiguous)", () => {
    expect(resolveScheduleAt("2026-07-04T12:00")).toBeNull();
  });

  test("a bogus timezone → null (not a crash)", () => {
    expect(resolveScheduleAt("2026-07-04T12:00", "Not/A_Zone")).toBeNull();
  });

  test("an unparseable string → null", () => {
    expect(resolveScheduleAt("tomorrow noon")).toBeNull();
    expect(resolveScheduleAt("")).toBeNull();
  });
});

describe("schedule_publish tool", () => {
  test('registered in both TOOL_FNS and TOOL_DEFS (GLM can see it)', () => {
    expect(TOOL_FNS.schedule_publish).toBeInstanceOf(Function);
    const def = TOOL_DEFS.find((t) => t.function.name === "schedule_publish");
    expect(def).toBeDefined();
    // The description must mention BOTH the ISO-instant and wall-time+timezone
    // paths so the model doesn't send a wall time without a zone.
    expect(def!.function.description).toMatch(/timezone/i);
    expect(def!.function.description).toMatch(/ISO/i);
  });

  test("happy path with a local time + IANA timezone → committed as UTC", async () => {
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T12:00", timezone: "Europe/Lisbon" },
      "ws1",
    );
    expect(result.ok).toBe(true);
    // The stored value is a UTC instant (11:00Z for a Lisbon-DST noon in 2099).
    expect(String((result as { scheduledAt: string }).scheduledAt)).toMatch(/^\d{4}-\d{2}-\d{2}T11:00:00\.000Z$/);
    // And the DB write happened with schedule_status='scheduled'.
    expect(state.draftPatch).toMatchObject({ schedule_status: "scheduled" });
  });

  test("wall time WITHOUT a timezone AND no workspace default → needs_timezone error (asks the user)", async () => {
    state.workspaceTimezone = null;
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T12:00" },
      "ws1",
    );
    expect(result.ok).toBe(false);
    // The message the agent will relay must nudge the model to ASK the user.
    expect(String((result as { error: string }).error)).toMatch(/timezone/i);
    expect(state.draftPatch).toBeNull();
  });

  test("wall time WITHOUT a timezone BUT workspace has a default → resolved with the default", async () => {
    state.workspaceTimezone = "Europe/Lisbon";
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T12:00" },
      "ws1",
    );
    expect(result.ok).toBe(true);
    // Lisbon DST (WEST, UTC+1) in July → 12:00 local == 11:00Z.
    expect(String((result as { scheduledAt: string }).scheduledAt)).toMatch(/T11:00:00\.000Z$/);
    expect(state.draftPatch).toMatchObject({ schedule_status: "scheduled" });
  });

  test("an explicit timezone arg still wins over the workspace default (no silent swap)", async () => {
    state.workspaceTimezone = "Europe/Lisbon";
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T12:00", timezone: "America/New_York" },
      "ws1",
    );
    expect(result.ok).toBe(true);
    // NYC EDT (UTC-4) → 12:00 local == 16:00Z, NOT the Lisbon 11:00Z.
    expect(String((result as { scheduledAt: string }).scheduledAt)).toMatch(/T16:00:00\.000Z$/);
  });

  test("no LinkedIn connection → not_connected error, nothing written", async () => {
    state.conn = { status: "disconnected", zernio_account_id: null };
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T16:00:00Z" },
      "ws1",
    );
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toMatch(/settings/i);
    expect(state.draftPatch).toBeNull();
  });

  test("a pending_review draft → error (approve first)", async () => {
    state.draft = { id: "d1", body: "ok", status: "pending_review" };
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T16:00:00Z" },
      "ws1",
    );
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toMatch(/approve/i);
    expect(state.draftPatch).toBeNull();
  });

  test("a past time → error", async () => {
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2000-01-01T00:00:00Z" },
      "ws1",
    );
    expect(result.ok).toBe(false);
  });

  test("missing id → clear error", async () => {
    const result = await TOOL_FNS.schedule_publish!(
      { scheduledAt: "2099-07-04T16:00:00Z" },
      "ws1",
    );
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toMatch(/id/i);
  });

  test("rescheduling WITHOUT firstComment does NOT touch first_comment (no wipe)", async () => {
    // "move that to 11:00" — the model omits firstComment; a previously-saved
    // first comment must survive. The UPDATE patch must NOT include first_comment.
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T16:00:00Z" },
      "ws1",
    );
    expect(result.ok).toBe(true);
    expect(state.draftPatch).not.toHaveProperty("first_comment");
  });

  test("passing firstComment='' explicitly CLEARS it (in the patch as null)", async () => {
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T16:00:00Z", firstComment: "" },
      "ws1",
    );
    expect(result.ok).toBe(true);
    expect(state.draftPatch).toHaveProperty("first_comment", null);
  });

  test("an over-long firstComment is capped, not sent whole (no 3× retry waste downstream)", async () => {
    const result = await TOOL_FNS.schedule_publish!(
      { id: "d1", scheduledAt: "2099-07-04T16:00:00Z", firstComment: "x".repeat(5000) },
      "ws1",
    );
    expect(result.ok).toBe(true);
    expect(String(state.draftPatch!.first_comment).length).toBeLessThanOrEqual(3000);
  });
});

describe("cancel_publish tool", () => {
  test("registered", () => {
    expect(TOOL_FNS.cancel_publish).toBeInstanceOf(Function);
    expect(TOOL_DEFS.find((t) => t.function.name === "cancel_publish")).toBeDefined();
  });

  test("cancels a scheduled draft → ok", async () => {
    const result = await TOOL_FNS.cancel_publish!({ id: "d1" }, "ws1");
    expect(result.ok).toBe(true);
    expect(state.draftPatch).toMatchObject({ schedule_status: null, scheduled_at: null });
  });

  test("nothing to cancel (row not in 'scheduled') → error", async () => {
    state.deleteMatched = false;
    const result = await TOOL_FNS.cancel_publish!({ id: "d1" }, "ws1");
    expect(result.ok).toBe(false);
  });
});
