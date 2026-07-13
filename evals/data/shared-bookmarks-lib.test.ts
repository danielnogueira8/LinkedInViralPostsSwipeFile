import { beforeEach, describe, expect, test, vi } from "vitest";

// Direct unit coverage for lib/shared-bookmarks.ts's own authorization logic.
// Every OTHER test in the suite mocks this module away (it's a dependency of
// the routes they're really testing), so resolveActiveLibrary's actual
// branches — revoked share, wrong recipient, missing share — never execute
// anywhere else. This is the sole gate against a caller reading another
// workspace's bookmark library, so it gets tested unmocked, against a fake
// Supabase client, the way the module really runs.

const CALLER_WORKSPACE = "workspace-caller";
const OWNER_WORKSPACE = "workspace-owner";
const SHARE_ID = "11111111-1111-4111-8111-111111111111";

let currentUserId: string | null = "user-recipient";
let shareRow: {
  id: string;
  owner_workspace_id: string;
  recipient_user_id: string | null;
  status: string;
} | null = {
  id: SHARE_ID,
  owner_workspace_id: OWNER_WORKSPACE,
  recipient_user_id: "user-recipient",
  status: "accepted",
};

function fakeRaw() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      };
      chain.maybeSingle = async () => {
        if (table !== "shared_bookmarks") return { data: null, error: null };
        if (!shareRow || filters.id !== shareRow.id) {
          return { data: null, error: null };
        }
        return { data: shareRow, error: null };
      };
      return chain;
    },
  };
}

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: currentUserId }),
}));
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: CALLER_WORKSPACE, raw: fakeRaw() }),
}));
vi.mock("@/lib/workspace-display", () => ({
  resolveWorkspaceDisplays: async () => new Map(),
}));
vi.mock("@/lib/retry-read", () => ({
  retryRead: async (fn: () => Promise<unknown>) => {
    try {
      return { data: (await fn()) as unknown, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  },
}));

const {
  resolveActiveLibrary,
  canHardMutate,
  verifiedPrimaryEmail,
  SharedBookmarkAccessError,
} = await import("@/lib/shared-bookmarks");

beforeEach(() => {
  currentUserId = "user-recipient";
  shareRow = {
    id: SHARE_ID,
    owner_workspace_id: OWNER_WORKSPACE,
    recipient_user_id: "user-recipient",
    status: "accepted",
  };
});

describe("resolveActiveLibrary: authorization gate for cross-workspace bookmark access", () => {
  test("no shareId → caller's own workspace, kind 'own'", async () => {
    const active = await resolveActiveLibrary(null);
    expect(active).toEqual({
      kind: "own",
      workspaceId: CALLER_WORKSPACE,
      userId: "user-recipient",
    });
  });

  test("valid accepted share for the signed-in recipient → owner's workspace, kind 'shared'", async () => {
    const active = await resolveActiveLibrary(SHARE_ID);
    expect(active).toEqual({
      kind: "shared",
      workspaceId: OWNER_WORKSPACE,
      shareId: SHARE_ID,
      userId: "user-recipient",
    });
  });

  test("signed-out caller requesting a shared library is rejected outright", async () => {
    currentUserId = null;
    await expect(resolveActiveLibrary(SHARE_ID)).rejects.toBeInstanceOf(
      SharedBookmarkAccessError,
    );
  });

  test("a share id that doesn't exist is rejected, not silently treated as 'own'", async () => {
    shareRow = null;
    await expect(resolveActiveLibrary(SHARE_ID)).rejects.toBeInstanceOf(
      SharedBookmarkAccessError,
    );
  });

  test("a share that hasn't been accepted yet (pending) is rejected", async () => {
    shareRow!.status = "pending";
    await expect(resolveActiveLibrary(SHARE_ID)).rejects.toBeInstanceOf(
      SharedBookmarkAccessError,
    );
  });

  test("a REVOKED share is rejected — this is the core leak this function guards against", async () => {
    shareRow!.status = "revoked";
    await expect(resolveActiveLibrary(SHARE_ID)).rejects.toBeInstanceOf(
      SharedBookmarkAccessError,
    );
  });

  test("a valid, accepted share belonging to a DIFFERENT user is rejected for this caller", async () => {
    // The share row is real and accepted, but bound to someone else's Clerk
    // user id — the exact "wrong recipient" cross-user leak this function
    // exists to prevent. currentUserId stays "user-recipient" (a real signed-in
    // user), just not the one the share is bound to.
    shareRow!.recipient_user_id = "user-someone-else";
    await expect(resolveActiveLibrary(SHARE_ID)).rejects.toBeInstanceOf(
      SharedBookmarkAccessError,
    );
  });

  test("the 'not found' and 'not yours' failures are indistinguishable to the caller", async () => {
    // Both must surface the SAME message so a caller can't probe share ids to
    // learn which ones exist for other recipients.
    shareRow = null;
    let notFoundMessage = "";
    try {
      await resolveActiveLibrary(SHARE_ID);
    } catch (e) {
      notFoundMessage = (e as Error).message;
    }

    shareRow = {
      id: SHARE_ID,
      owner_workspace_id: OWNER_WORKSPACE,
      recipient_user_id: "user-someone-else",
      status: "accepted",
    };
    let wrongRecipientMessage = "";
    try {
      await resolveActiveLibrary(SHARE_ID);
    } catch (e) {
      wrongRecipientMessage = (e as Error).message;
    }

    expect(notFoundMessage).toBe(wrongRecipientMessage);
  });
});

describe("canHardMutate: per-row mutation gate inside a shared library", () => {
  test("the library owner ('own' kind) can always mutate, regardless of who created the row", () => {
    const owner = { kind: "own" as const, workspaceId: CALLER_WORKSPACE, userId: "user-recipient" };
    expect(canHardMutate(owner, { created_by_user_id: "someone-else" })).toBe(true);
    expect(canHardMutate(owner, { created_by_user_id: null })).toBe(true);
  });

  test("a shared-library recipient can mutate only rows THEY created", () => {
    const shared = {
      kind: "shared" as const,
      workspaceId: OWNER_WORKSPACE,
      shareId: SHARE_ID,
      userId: "user-recipient",
    };
    expect(canHardMutate(shared, { created_by_user_id: "user-recipient" })).toBe(true);
  });

  test("a shared-library recipient CANNOT mutate a row the owner (or another recipient) created", () => {
    const shared = {
      kind: "shared" as const,
      workspaceId: OWNER_WORKSPACE,
      shareId: SHARE_ID,
      userId: "user-recipient",
    };
    expect(canHardMutate(shared, { created_by_user_id: null })).toBe(false);
    expect(canHardMutate(shared, { created_by_user_id: "the-owner" })).toBe(false);
    expect(canHardMutate(shared, { created_by_user_id: "another-recipient" })).toBe(false);
  });
});

describe("verifiedPrimaryEmail: invite-binding must key off a proven email only", () => {
  test("returns the lowercased primary email when it's verified", () => {
    expect(
      verifiedPrimaryEmail({
        primaryEmailAddressId: "email-1",
        emailAddresses: [
          { id: "email-1", emailAddress: "Person@Example.com", verification: { status: "verified" } },
        ],
      }),
    ).toBe("person@example.com");
  });

  test("an UNVERIFIED primary email must not resolve an invite", () => {
    expect(
      verifiedPrimaryEmail({
        primaryEmailAddressId: "email-1",
        emailAddresses: [
          { id: "email-1", emailAddress: "person@example.com", verification: { status: "unverified" } },
        ],
      }),
    ).toBeNull();
  });

  test("a verified SECONDARY email (not primary) must not be used — no arbitrary-address fallback", () => {
    expect(
      verifiedPrimaryEmail({
        primaryEmailAddressId: "email-1",
        emailAddresses: [
          { id: "email-1", emailAddress: "unverified@example.com", verification: { status: "unverified" } },
          { id: "email-2", emailAddress: "verified-secondary@example.com", verification: { status: "verified" } },
        ],
      }),
    ).toBeNull();
  });

  test("null/missing user → null, no crash", () => {
    expect(verifiedPrimaryEmail(null)).toBeNull();
    expect(verifiedPrimaryEmail(undefined)).toBeNull();
    expect(verifiedPrimaryEmail({})).toBeNull();
  });
});
