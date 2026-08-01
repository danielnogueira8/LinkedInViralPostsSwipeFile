import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateManagedOpportunityStatus } from "@/lib/agent-loop/opportunity-claim";

const actSource = readFileSync("lib/agent-loop/act.ts", "utf8");
const routeSource = readFileSync(
  "app/api/agent/opportunities/[id]/route.ts",
  "utf8",
);
const migrationSource = readFileSync(
  "db/migration-167-agent-opportunity-claim.sql",
  "utf8",
);

function fakeClient(result: { data: unknown; error: null | Error }) {
  const calls: { filters: Array<[string, unknown]>; values: unknown } = {
    filters: [],
    values: null,
  };
  const query = {
    from: () => query,
    update: (values: unknown) => {
      calls.values = values;
      return query;
    },
    eq: (column: string, value: unknown) => {
      calls.filters.push([column, value]);
      return query;
    },
    select: () => query,
    maybeSingle: async () => result,
  };
  return {
    client: query as unknown as SupabaseClient,
    calls,
  };
}

describe("agent opportunity claims", () => {
  test("claims only a still-proposed opportunity", async () => {
    const { client, calls } = fakeClient({ data: { id: "opp-1" }, error: null });

    await expect(
      updateManagedOpportunityStatus(
        client,
        "workspace-1",
        "opp-1",
        "proposed",
        { status: "drafting" },
      ),
    ).resolves.toBe(true);
    expect(calls.values).toEqual({ status: "drafting" });
    expect(calls.filters).toEqual([
      ["id", "opp-1"],
      ["workspace_id", "workspace-1"],
      ["status", "proposed"],
    ]);
  });

  test("reports a lost claim without pretending the draft started", async () => {
    const { client } = fakeClient({ data: null, error: null });

    await expect(
      updateManagedOpportunityStatus(
        client,
        "workspace-1",
        "opp-1",
        "proposed",
        { status: "drafting" },
      ),
    ).resolves.toBe(false);
  });

  test("the actor and route handle a concurrent loser as an already-handled action", () => {
    expect(actSource).toContain('reason: "already_handled"');
    expect(actSource).toContain('"proposed"');
    expect(routeSource).toContain('result.reason === "already_handled"');
    expect(routeSource).toContain('{ status: 409 }');
  });

  test("the system chat has one active row per workspace", () => {
    expect(migrationSource).toContain("chats_agent_system_live_idx");
    expect(migrationSource).toContain("title = 'Your agent'");
    expect(migrationSource).toContain("archived_at is null");
    expect(actSource).toContain('createError?.code !== "23505"');
  });
});
