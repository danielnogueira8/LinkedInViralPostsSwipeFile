import { describe, expect, test, vi } from "vitest";
import { createWorkspaceAccountWriter } from "@/lib/tracked-creators-supabase";

type AccountRow = {
  id: string;
  source: string;
  manual_owner_workspace_id: string | null;
  name: string;
};

function serviceClientFor(row: AccountRow) {
  const filters = new Map<string, unknown>();
  let patch: Record<string, unknown> = {};
  let updated = false;
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    update: (value: Record<string, unknown>) => {
      patch = value;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      filters.set(column, value);
      return chain;
    },
    select: () => chain,
    maybeSingle: async () => {
      const matches = [...filters].every(
        ([column, value]) => row[column as keyof AccountRow] === value,
      );
      if (!matches) return { data: null, error: null };
      updated = true;
      return { data: { ...row, ...patch }, error: null };
    },
  });
  return {
    client: { from: vi.fn(() => chain) },
    wasUpdated: () => updated,
  };
}

describe("manual account service writer", () => {
  test.each([
    {
      label: "an unowned global row",
      row: { id: "account-1", source: "catalog", manual_owner_workspace_id: null },
    },
    {
      label: "another workspace's manual row",
      row: {
        id: "account-1",
        source: "manual",
        manual_owner_workspace_id: "workspace-2",
      },
    },
    {
      label: "a non-manual row carrying the workspace id",
      row: {
        id: "account-1",
        source: "catalog",
        manual_owner_workspace_id: "workspace-1",
      },
    },
  ])("cannot update $label", async ({ row }) => {
    const db = serviceClientFor({ ...row, name: "Original" });
    const writer = createWorkspaceAccountWriter("workspace-1", db.client as never);

    await expect(writer.updateAccount("account-1", { name: "Changed" })).resolves.toBeNull();
    expect(db.wasUpdated()).toBe(false);
  });

  test("updates a manual row owned by the current workspace", async () => {
    const db = serviceClientFor({
      id: "account-1",
      source: "manual",
      manual_owner_workspace_id: "workspace-1",
      name: "Original",
    });
    const writer = createWorkspaceAccountWriter("workspace-1", db.client as never);

    await expect(writer.updateAccount("account-1", { name: "Changed" })).resolves.toMatchObject({
      id: "account-1",
      name: "Changed",
    });
    expect(db.wasUpdated()).toBe(true);
  });
});
