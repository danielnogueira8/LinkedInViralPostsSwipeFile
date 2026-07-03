import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// Publishing connections (lib/publishing.ts) — the workspace ↔ Zernio-LinkedIn
// link the scheduler publishes through. Security-critical: every read/write MUST
// be workspace-scoped (a leak here = posting to / reading another workspace's
// LinkedIn). Zernio's network calls are stubbed; supabaseAdmin is faked.
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));

// Stub the Zernio client so ensureProfile/finalize don't hit the network.
const zernio = {
  createProfile: vi.fn(async () => "prof-new"),
  listAccounts: vi.fn(async () => [] as Array<Record<string, unknown>>),
};
vi.mock("@/lib/zernio", () => ({
  createProfile: (...a: unknown[]) => zernio.createProfile(...(a as [])),
  listAccounts: (...a: unknown[]) => zernio.listAccounts(...(a as [])),
}));

const { getConnection, canPublish, ensureProfile, finalizeConnection, markDisconnected } =
  await import("@/lib/publishing");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  zernio.createProfile.mockClear();
  zernio.listAccounts.mockClear();
  zernio.createProfile.mockResolvedValue("prof-new");
  zernio.listAccounts.mockResolvedValue([]);
});

describe("getConnection — workspace-scoped read", () => {
  test("scopes by workspace_id AND network", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { single: { id: "c1", workspace_id: "ws", status: "active" } },
    });
    const c = await getConnection("ws");
    expect(c?.id).toBe("c1");
    const q = queryFor(dbRef.current, "publishing_connections")!;
    const eqs = q.filters.filter((f) => f.method === "eq");
    expect(eqs.some((f) => f.args[0] === "workspace_id" && f.args[1] === "ws")).toBe(true);
    expect(eqs.some((f) => f.args[0] === "network" && f.args[1] === "linkedin")).toBe(true);
  });

  test("null when the workspace has never connected", async () => {
    dbRef.current = makeFakeSupabase({ publishing_connections: { single: null } });
    expect(await getConnection("ws")).toBeNull();
  });
});

describe("canPublish — the gate the schedule endpoint + cron use", () => {
  const base = { id: "c", workspace_id: "ws", network: "linkedin", zernio_profile_id: "p", display_name: null, avatar_url: null, account_type: "personal" as const, disconnected_reason: null };
  test("true only when active AND an account id is resolved", () => {
    expect(canPublish({ ...base, status: "active", zernio_account_id: "acct-1" })).toBe(true);
  });
  test("false when disconnected, or active-but-no-account, or null", () => {
    expect(canPublish({ ...base, status: "disconnected", zernio_account_id: "acct-1" })).toBe(false);
    expect(canPublish({ ...base, status: "active", zernio_account_id: null })).toBe(false);
    expect(canPublish(null)).toBe(false);
  });
});

describe("ensureProfile — create-once, reuse-after", () => {
  test("reuses an existing profile id (no new Zernio profile)", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { single: { id: "c1", workspace_id: "ws", zernio_profile_id: "prof-existing" } },
    });
    const id = await ensureProfile("ws");
    expect(id).toBe("prof-existing");
    expect(zernio.createProfile).not.toHaveBeenCalled();
  });

  test("first connect → creates a profile and upserts a PENDING (disconnected) row for the workspace", async () => {
    dbRef.current = makeFakeSupabase({ publishing_connections: { single: null } });
    const id = await ensureProfile("ws");
    expect(id).toBe("prof-new");
    expect(zernio.createProfile).toHaveBeenCalledTimes(1);
    // The upsert row is workspace-scoped, carries the profile, and is NOT active yet.
    const upserts = dbRef.current.queries
      .filter((q) => q.table === "publishing_connections")
      .flatMap((q) => q.filters.filter((f) => f.method === "upsert").map((f) => f.args[0] as Record<string, unknown>));
    expect(upserts.length).toBe(1);
    expect(upserts[0]).toMatchObject({
      workspace_id: "ws",
      network: "linkedin",
      zernio_profile_id: "prof-new",
      status: "disconnected",
    });
  });
});

describe("finalizeConnection — links the account from GET /v1/accounts", () => {
  test("picks the active LinkedIn account for the profile and writes it as active", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { single: { id: "c1", workspace_id: "ws", zernio_profile_id: "prof-1" } },
    });
    zernio.listAccounts.mockResolvedValue([
      { id: "acct-x", platform: "twitter", displayName: "x", profileUrl: null, isActive: true },
      { id: "acct-li", platform: "linkedin", displayName: "Jane", profileUrl: "u", isActive: true },
    ]);
    const ok = await finalizeConnection("ws");
    expect(ok).toBe(true);
    // listAccounts scoped to the workspace's profile.
    expect(zernio.listAccounts).toHaveBeenCalledWith("prof-1");
    // The update sets the account id + active, scoped to the workspace.
    const upd = dbRef.current.queries
      .filter((q) => q.table === "publishing_connections")
      .flatMap((q) => {
        const patch = q.filters.find((f) => f.method === "update")?.args[0] as Record<string, unknown> | undefined;
        if (!patch) return [];
        const eqs = q.filters.filter((f) => f.method === "eq").map((f) => f.args);
        return [{ patch, eqs }];
      })[0];
    expect(upd.patch).toMatchObject({ zernio_account_id: "acct-li", status: "active", display_name: "Jane" });
    expect(upd.eqs).toContainEqual(["workspace_id", "ws"]);
  });

  test("returns false when no LinkedIn account is found (nothing written active)", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { single: { id: "c1", workspace_id: "ws", zernio_profile_id: "prof-1" } },
    });
    zernio.listAccounts.mockResolvedValue([
      { id: "acct-x", platform: "twitter", displayName: "x", profileUrl: null, isActive: true },
    ]);
    expect(await finalizeConnection("ws")).toBe(false);
  });

  test("returns false when the workspace has no profile yet", async () => {
    dbRef.current = makeFakeSupabase({ publishing_connections: { single: null } });
    expect(await finalizeConnection("ws")).toBe(false);
    expect(zernio.listAccounts).not.toHaveBeenCalled();
  });
});

describe("markDisconnected — workspace-scoped", () => {
  test("flips status to disconnected for this workspace only", async () => {
    await markDisconnected("ws", "Token expired");
    const q = queryFor(dbRef.current, "publishing_connections")!;
    const patch = q.filters.find((f) => f.method === "update")!.args[0] as Record<string, unknown>;
    expect(patch.status).toBe("disconnected");
    expect(patch.disconnected_reason).toBe("Token expired");
    const eqs = q.filters.filter((f) => f.method === "eq").map((f) => f.args[0]);
    expect(eqs).toContain("workspace_id");
    expect(eqs).toContain("network");
  });
});
