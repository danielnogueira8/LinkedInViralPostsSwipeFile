import { beforeEach, describe, expect, test, vi } from "vitest";
import { filterArgs, makeFakeSupabase, type FakeDb } from "./fake-supabase";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => dbRef.current.client,
}));

vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => [],
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");

type Handler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<unknown>;

function tools() {
  const registered: Record<string, Handler> = {};
  registerSwipeTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered[name] = handler;
    },
  } as never);
  return registered;
}

function extra() {
  return { authInfo: { extra: { workspaceId: "workspace-a" } } };
}

function json(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]
    ?.text;
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

const ACCOUNT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Creator",
  linkedin_handle: "creator",
  profile_url: "https://www.linkedin.com/in/creator",
  niche: "Marketing",
  category_id: null,
  profile_pic_url: null,
  source: "manual",
  archived_at: null,
  manual_owner_workspace_id: "workspace-a",
  synced_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

describe("MCP TrackedCreators parity", () => {
  test("list uses the same workspace-bound repository and result policy", async () => {
    dbRef.current = makeFakeSupabase({
      workspace_accounts: {
        rows: [
          {
            niche: "AI",
            added_at: "2026-01-02T00:00:00.000Z",
            accounts: ACCOUNT,
          },
        ],
      },
    });

    const result = json(await tools().list_accounts({}, extra()));

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(
      (result.accounts as Array<Record<string, unknown>>)[0],
    ).toMatchObject({
      id: ACCOUNT.id,
      workspace_niche: "AI",
      effective_niche: "AI",
    });
    expect(filterArgs(dbRef.current, "workspace_accounts", "eq")).toEqual([
      "workspace_id",
      "workspace-a",
    ]);
  });

  test("update resolves the account but mutates only this workspace membership", async () => {
    dbRef.current = makeFakeSupabase({
      accounts: { single: ACCOUNT },
      workspace_accounts: { single: { account_id: ACCOUNT.id } },
    });

    const result = json(
      await tools().update_account({ id: ACCOUNT.id, niche: "AI" }, extra()),
    );

    expect(result.ok).toBe(true);
    const membership = dbRef.current.queries.find(
      (query) =>
        query.table === "workspace_accounts" &&
        query.filters.some((filter) => filter.method === "update"),
    );
    expect(
      membership?.filters.find(
        (filter) => filter.method === "eq" && filter.args[0] === "workspace_id",
      )?.args[1],
    ).toBe("workspace-a");
  });

  test("remove verifies membership and deletes only the current workspace row", async () => {
    dbRef.current = makeFakeSupabase({
      accounts: { single: ACCOUNT },
      workspace_accounts: {
        singles: [{ account_id: ACCOUNT.id }, { account_id: ACCOUNT.id }],
      },
    });

    const result = json(
      await tools().remove_account({ id: ACCOUNT.id }, extra()),
    );

    expect(result).toMatchObject({
      ok: true,
      untracked_account_id: ACCOUNT.id,
    });
    const deletion = dbRef.current.queries.find(
      (query) =>
        query.table === "workspace_accounts" &&
        query.filters.some((filter) => filter.method === "delete"),
    );
    expect(
      deletion?.filters.find(
        (filter) => filter.method === "eq" && filter.args[0] === "workspace_id",
      )?.args[1],
    ).toBe("workspace-a");
  });
});
