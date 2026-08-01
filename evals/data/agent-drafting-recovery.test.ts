import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_OPPORTUNITY_DRAFT_LEASE_MS,
  recoverStaleAgentOpportunityDrafts,
  updateManagedOpportunityStatus,
} from "@/lib/agent-loop/opportunity-claim";
import {
  recoverStaleDraftingItems,
  type StoredWeekPlan,
} from "@/lib/agent-loop/week-plan-store";

const actSource = readFileSync("lib/agent-loop/act.ts", "utf8");
const cronSource = readFileSync("app/api/cron/agent-loop/route.ts", "utf8");
const opportunityRouteSource = readFileSync(
  "app/api/agent/opportunities/[id]/route.ts",
  "utf8",
);
const weekPlanDraftSource = readFileSync(
  "app/api/agent/week-plan/draft/route.ts",
  "utf8",
);
const weekPlanRouteSource = readFileSync("app/api/agent/week-plan/route.ts", "utf8");
const migrationSource = readFileSync(
  "db/migration-168-agent-drafting-leases.sql",
  "utf8",
);

function recoveryClient(rows: Array<{ id: string }>) {
  const calls = {
    values: null as unknown,
    filters: [] as Array<[string, unknown]>,
  };
  const query = {
    update: (values: unknown) => {
      calls.values = values;
      return query;
    },
    eq: (column: string, value: unknown) => {
      calls.filters.push([column, value]);
      return query;
    },
    lt: (column: string, value: unknown) => {
      calls.filters.push([column, value]);
      return query;
    },
    select: async () => ({ data: rows, error: null }),
  };
  return {
    client: {
      from: () => query,
    } as unknown as SupabaseClient,
    calls,
  };
}

function fencedOpportunityClient() {
  let status = "proposed";
  let draftingStartedAt: string | null = null;
  const db = {
    from: () => {
      let values: Record<string, unknown> = {};
      let expectedStatus = "";
      let expectedLease: string | null = null;
      let recovering = false;
      const query = {
        update: (nextValues: Record<string, unknown>) => {
          values = nextValues;
          return query;
        },
        eq: (column: string, value: unknown) => {
          if (column === "status") expectedStatus = String(value);
          if (column === "drafting_started_at") expectedLease = String(value);
          return query;
        },
        lt: () => {
          recovering = true;
          return query;
        },
        select: () => query,
        maybeSingle: async () => {
          if (
            status !== expectedStatus ||
            (expectedLease !== null && draftingStartedAt !== expectedLease)
          ) {
            return { data: null, error: null };
          }
          status = String(values.status);
          draftingStartedAt =
            typeof values.drafting_started_at === "string"
              ? values.drafting_started_at
              : null;
          return { data: { id: "opp-1" }, error: null };
        },
        then: (
          resolve: (result: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          if (!recovering) return Promise.resolve().then(resolve, reject);
          if (status === "drafting") {
            status = "proposed";
            draftingStartedAt = null;
            return Promise.resolve({ data: [{ id: "opp-1" }], error: null }).then(
              resolve,
              reject,
            );
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return {
    client: db as unknown as SupabaseClient,
    state: () => ({ status, draftingStartedAt }),
  };
}

function planWithDrafting(
  draftingStartedAt: string | null | undefined,
): StoredWeekPlan {
  return {
    version: 1,
    weekStart: "2026-07-27",
    items: Array.from({ length: 7 }, (_, index) => ({
      id: `item-${index}`,
      day: "Mon",
      date: `2026-07-${String(27 + index).padStart(2, "0")}`,
      kind: "generic" as const,
      prompt: "Tell a real story",
      userContext: "A real customer story with a concrete outcome.",
      selectedLeadMagnetId: null,
      status: index === 0 ? ("drafting" as const) : ("planned" as const),
      draftId: null,
      ...(draftingStartedAt === undefined ? {} : { draftingStartedAt }),
    })),
  };
}

describe("agent drafting lease recovery", () => {
  test("returns stale opportunity claims to proposed atomically", async () => {
    const { client, calls } = recoveryClient([{ id: "opp-1" }]);
    const now = new Date("2026-08-01T12:00:00.000Z");

    await expect(
      recoverStaleAgentOpportunityDrafts(client, "workspace-1", now),
    ).resolves.toBe(1);

    expect(calls.values).toEqual({
      status: "proposed",
      drafting_started_at: null,
    });
    expect(calls.filters).toEqual([
      ["workspace_id", "workspace-1"],
      ["status", "drafting"],
      [
        "drafting_started_at",
        new Date(now.getTime() - AGENT_OPPORTUNITY_DRAFT_LEASE_MS).toISOString(),
      ],
    ]);
  });

  test("a recovered worker cannot overwrite a newer drafting claim", async () => {
    const state = fencedOpportunityClient();
    const firstLease = "2026-08-01T11:00:00.000Z";
    const secondLease = "2026-08-01T11:16:00.000Z";

    await expect(
      updateManagedOpportunityStatus(
        state.client,
        "workspace-1",
        "opp-1",
        "proposed",
        { status: "drafting", drafting_started_at: firstLease },
      ),
    ).resolves.toBe(true);
    await expect(
      recoverStaleAgentOpportunityDrafts(
        state.client,
        "workspace-1",
        new Date("2026-08-01T12:00:00.000Z"),
      ),
    ).resolves.toBe(1);
    await expect(
      updateManagedOpportunityStatus(
        state.client,
        "workspace-1",
        "opp-1",
        "proposed",
        { status: "drafting", drafting_started_at: secondLease },
      ),
    ).resolves.toBe(true);

    await expect(
      updateManagedOpportunityStatus(
        state.client,
        "workspace-1",
        "opp-1",
        "drafting",
        { status: "drafted", drafting_started_at: null },
        firstLease,
      ),
    ).resolves.toBe(false);
    expect(state.state()).toEqual({
      status: "drafting",
      draftingStartedAt: secondLease,
    });
  });

  test("reopens only expired weekly plan drafting items", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const stale = recoverStaleDraftingItems(
      planWithDrafting("2026-08-01T11:44:00.000Z"),
      now,
    );
    const fresh = recoverStaleDraftingItems(
      planWithDrafting("2026-08-01T11:50:00.000Z"),
      now,
    );
    const legacy = recoverStaleDraftingItems(planWithDrafting(undefined), now);
    const legacyStale = recoverStaleDraftingItems(
      planWithDrafting(undefined),
      now,
      AGENT_OPPORTUNITY_DRAFT_LEASE_MS,
      "2026-08-01T11:44:00.000Z",
    );

    expect(stale.recovered).toBe(true);
    expect(stale.plan.items[0]).toMatchObject({
      status: "planned",
      draftId: null,
      draftingStartedAt: null,
    });
    expect(fresh).toEqual({
      plan: planWithDrafting("2026-08-01T11:50:00.000Z"),
      recovered: false,
    });
    expect(legacy.plan.items[0].status).toBe("drafting");
    expect(legacy.recovered).toBe(false);
    expect(legacyStale.plan.items[0].status).toBe("planned");
    expect(legacyStale.recovered).toBe(true);
  });

  test("all drafting paths write, clear, and recover the lease", () => {
    expect(actSource).toContain("drafting_started_at: draftingStartedAt");
    expect(actSource).toContain("drafting_started_at: null");
    expect(cronSource).toContain("recoverStaleAgentOpportunityDrafts");
    expect(opportunityRouteSource).toContain(
      "recoverStaleAgentOpportunityDrafts",
    );
    expect(weekPlanDraftSource).toContain(
      "recoverStaleWeekPlanDraftsAcross",
    );
    expect(weekPlanDraftSource).toContain("draftingStartedAt");
    expect(weekPlanDraftSource).toContain(
      "current.draftingStartedAt === expectedDraftingStartedAt",
    );
    expect(weekPlanRouteSource).toContain("recoverStaleWeekPlanDrafts");
    expect(migrationSource).toContain("drafting_started_at timestamptz");
    expect(migrationSource).toContain(
      "agent_opportunities_drafting_lease_idx",
    );
    expect(migrationSource).toContain(
      "agent_opportunities_drafting_lease_trg",
    );
    expect(migrationSource).toContain(
      "public.agent_opportunities.drafting_started_at",
    );
  });
});
