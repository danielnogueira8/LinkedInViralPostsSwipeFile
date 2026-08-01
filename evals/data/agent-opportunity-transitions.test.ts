import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  raw: null as unknown,
  recoverStaleAgentOpportunityDrafts: vi.fn(),
  updateManagedOpportunityStatus: vi.fn(),
  actOnOpportunity: vi.fn(),
  markStoredOpportunityDrafted: vi.fn(),
}));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "workspace-1", raw: mocked.raw }),
}));
vi.mock("@/lib/agent-loop/opportunity-claim", () => ({
  recoverStaleAgentOpportunityDrafts: mocked.recoverStaleAgentOpportunityDrafts,
  updateManagedOpportunityStatus: mocked.updateManagedOpportunityStatus,
}));
vi.mock("@/lib/agent-loop/act", () => ({
  actOnOpportunity: mocked.actOnOpportunity,
}));
vi.mock("@/lib/agent-loop/week-plan", () => ({ weekStart: () => "2026-07-27" }));
vi.mock("@/lib/agent-loop/week-plan-store", () => ({
  markStoredOpportunityDrafted: mocked.markStoredOpportunityDrafted,
}));
vi.mock("@/lib/workspace", () => ({
  errorResponse: () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
}));

import { POST } from "@/app/api/agent/opportunities/[id]/route";

const routeSource = readFileSync(
  "app/api/agent/opportunities/[id]/route.ts",
  "utf8",
);

const proposedOpportunity = {
  id: "opp-1",
  kind: "trend",
  source_post_id: null,
  payload: {},
  status: "proposed",
};

function makeRaw() {
  return {
    from: (table: string) => {
      if (table !== "agent_opportunities") {
        throw new Error(`unexpected table ${table}`);
      }
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: proposedOpportunity, error: null }),
      };
      return query;
    },
  };
}

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/agent/opportunities/opp-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function post(body: Record<string, unknown>) {
  return POST(request(body), { params: Promise.resolve({ id: "opp-1" }) });
}

beforeEach(() => {
  mocked.raw = makeRaw();
  mocked.recoverStaleAgentOpportunityDrafts.mockReset();
  mocked.recoverStaleAgentOpportunityDrafts.mockResolvedValue(0);
  mocked.updateManagedOpportunityStatus.mockReset();
  mocked.actOnOpportunity.mockReset();
  mocked.markStoredOpportunityDrafted.mockReset();
});

describe("agent opportunity action transitions", () => {
  test("dismiss only wins while the opportunity is still proposed", () => {
    const branch = routeSource.slice(
      routeSource.indexOf('if (action === "dismiss")'),
      routeSource.indexOf('if (action === "snooze")'),
    );
    expect(branch).toContain("updateManagedOpportunityStatus");
    expect(branch).toContain('"proposed"');
    expect(branch).toContain("if (!dismissed)");
  });

  test("snooze checks the affected row before reporting success", () => {
    const snoozeStart = routeSource.indexOf('if (action === "snooze")');
    const statusCheck = 'if (opportunity.status !== "proposed")';
    const firstStatusCheck = routeSource.indexOf(statusCheck, snoozeStart);
    const branch = routeSource.slice(
      snoozeStart,
      routeSource.indexOf(statusCheck, firstStatusCheck + statusCheck.length),
    );
    expect(branch).toContain("updateManagedOpportunityStatus");
    expect(branch).toContain('"proposed"');
    expect(branch).toContain("if (!snoozed)");
  });

  test("dismiss executes a conditional transition and returns 409 when it loses", async () => {
    mocked.updateManagedOpportunityStatus.mockResolvedValueOnce(false);

    const response = await post({ action: "dismiss" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "This opportunity was already handled.",
    });
    expect(mocked.updateManagedOpportunityStatus).toHaveBeenCalledWith(
      mocked.raw,
      "workspace-1",
      "opp-1",
      "proposed",
      expect.objectContaining({ status: "dismissed" }),
    );
  });

  test("snooze executes a conditional transition and returns success only after a row changes", async () => {
    mocked.updateManagedOpportunityStatus.mockResolvedValueOnce(true);

    const response = await post({
      action: "snooze",
      until: "2026-08-02T12:00:00.000Z",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "snoozed" });
    expect(mocked.updateManagedOpportunityStatus).toHaveBeenCalledWith(
      mocked.raw,
      "workspace-1",
      "opp-1",
      "proposed",
      {
        status: "snoozed",
        snoozed_until: "2026-08-02T12:00:00.000Z",
      },
    );
  });

  test("draft success still marks the matching cadence opportunity", async () => {
    mocked.actOnOpportunity.mockResolvedValueOnce({
      ok: true,
      draftIds: ["draft-1"],
    });

    const response = await post({ action: "draft" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "drafted",
      draftIds: ["draft-1"],
    });
    expect(mocked.markStoredOpportunityDrafted).toHaveBeenCalledWith(
      mocked.raw,
      "workspace-1",
      "2026-07-27",
      "opp-1",
      "draft-1",
    );
  });
});
