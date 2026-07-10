import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// Publishing connections (lib/publishing.ts) — the workspace ↔ Zernio-LinkedIn
// link the scheduler publishes through. Security-critical: every read/write MUST
// be workspace-scoped (a leak here = posting to / reading another workspace's
// LinkedIn). Zernio's network calls are stubbed; supabaseAdmin is faked.
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
const profileClaim = vi.fn();
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ ...dbRef.current.client, rpc: profileClaim }),
}));

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
  profileClaim.mockReset();
  profileClaim.mockResolvedValue({
    data: [{ profile_id: null, claim_token: "claim-1", acquired: true }],
    error: null,
  });
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

  test("database errors are not misreported as no connection", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { error: { message: "connection read failed" } },
    });

    await expect(getConnection("ws")).rejects.toThrow("connection read failed");
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
  test("concurrent first-connect requests create only one remote profile", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { singles: [null, null, { id: "c1" }] },
    });
    let sequence = 0;
    zernio.createProfile.mockImplementation(async () => `prof-${++sequence}`);
    profileClaim
      .mockResolvedValueOnce({
        data: [{ profile_id: null, claim_token: "claim-1", acquired: true }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ profile_id: null, claim_token: null, acquired: false }],
        error: null,
      });

    const results = await Promise.allSettled([ensureProfile("ws"), ensureProfile("ws")]);

    expect(zernio.createProfile).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("reuses an existing profile id (no new Zernio profile)", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { single: { id: "c1", workspace_id: "ws", zernio_profile_id: "prof-existing" } },
    });
    const id = await ensureProfile("ws");
    expect(id).toBe("prof-existing");
    expect(zernio.createProfile).not.toHaveBeenCalled();
  });

  test("first connect → creates and saves a profile on the claimed connection row", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { singles: [null, { id: "c1" }] },
    });
    const id = await ensureProfile("ws");
    expect(id).toBe("prof-new");
    expect(zernio.createProfile).toHaveBeenCalledTimes(1);
    // The upsert row is workspace-scoped, carries the profile, and is NOT active yet.
    const updates = dbRef.current.queries
      .filter((q) => q.table === "publishing_connections")
      .flatMap((q) => q.filters.filter((f) => f.method === "update").map((f) => f.args[0] as Record<string, unknown>));
    expect(updates.length).toBe(1);
    expect(updates[0]).toMatchObject({
      zernio_profile_id: "prof-new",
      status: "disconnected",
    });
  });

  test("an active profile claim rejects without creating another remote profile", async () => {
    dbRef.current = makeFakeSupabase({ publishing_connections: { single: null } });
    profileClaim.mockResolvedValue({
      data: [{ profile_id: null, claim_token: null, acquired: false }],
      error: null,
    });

    await expect(ensureProfile("ws")).rejects.toThrow(/already in progress/i);
    expect(zernio.createProfile).not.toHaveBeenCalled();
  });

  test("a failed remote creation releases the database claim", async () => {
    dbRef.current = makeFakeSupabase({ publishing_connections: { single: null } });
    zernio.createProfile.mockRejectedValue(new Error("profile creation failed"));

    await expect(ensureProfile("ws")).rejects.toThrow("profile creation failed");

    const release = dbRef.current.queries
      .filter((q) => q.table === "publishing_connections")
      .flatMap((q) =>
        q.filters
          .filter((f) => f.method === "update")
          .map((f) => f.args[0] as Record<string, unknown>),
      )[0];
    expect(release).toMatchObject({
      profile_claim_token: null,
      profile_claimed_at: null,
    });
  });

  test("a failed profile upsert is not reported as a usable profile", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: {
        singles: [null, null],
        errors: [null, { message: "profile save failed" }],
      },
    });

    await expect(ensureProfile("ws")).rejects.toThrow("profile save failed");
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

  test("a failed active-state update is not reported as connected", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: {
        single: { id: "c1", workspace_id: "ws", zernio_profile_id: "prof-1" },
        errors: [null, { message: "finalize save failed" }],
      },
    });
    zernio.listAccounts.mockResolvedValue([
      { id: "acct-li", platform: "linkedin", displayName: "Jane", isActive: true },
    ]);

    await expect(finalizeConnection("ws")).rejects.toThrow("finalize save failed");
  });

  test("returns false when the connection disappears before the active-state update", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: {
        singles: [
          { id: "c1", workspace_id: "ws", zernio_profile_id: "prof-1" },
          null,
        ],
      },
    });
    zernio.listAccounts.mockResolvedValue([
      { id: "acct-li", platform: "linkedin", displayName: "Jane", isActive: true },
    ]);

    expect(await finalizeConnection("ws")).toBe(false);
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

  test("a failed disconnect write is surfaced", async () => {
    dbRef.current = makeFakeSupabase({
      publishing_connections: { error: { message: "disconnect save failed" } },
    });

    await expect(markDisconnected("ws", "Token expired")).rejects.toThrow(
      "disconnect save failed",
    );
  });
});
