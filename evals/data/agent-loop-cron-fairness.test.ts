import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { rotateForFairness } from "@/lib/agent-inbox/schedule";

const mocked = vi.hoisted(() => ({
  db: null as unknown,
  ranges: [] as Array<[string, number]>,
  scan: vi.fn(),
  recover: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => mocked.db,
}));
vi.mock("@/lib/agent-loop/scan", () => ({
  scanAgentOpportunities: (...args: unknown[]) => mocked.scan(...args),
}));
vi.mock("@/lib/agent-loop/trend-radar", () => ({
  scanTrendOpportunities: async () => ({
    searched: 0,
    fetched: 0,
    inserted: 0,
    expired: 0,
    skipped: 0,
  }),
}));
vi.mock("@/lib/agent-loop/opportunity-claim", () => ({
  recoverStaleAgentOpportunityDrafts: (...args: unknown[]) =>
    mocked.recover(...args),
}));
vi.mock("@/lib/supabase-scoped", () => ({
  latestRelevantScrape: async () => ({
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  }),
}));
vi.mock("@/lib/cron-alert", () => ({
  postCronAlert: (...args: unknown[]) => mocked.alert(...args),
}));
vi.mock("@/lib/workspace", () => ({
  errorResponse: () => Response.json({ ok: false }, { status: 500 }),
}));

import { GET } from "@/app/api/cron/agent-loop/route";

const routeSource = readFileSync("app/api/cron/agent-loop/route.ts", "utf8");

function makePagedDb() {
  return {
    from: (table: string) => {
      let from = 0;
      const query = {
        select: () => query,
        is: () => query,
        order: () => query,
        range: (start: number) => {
          from = start;
          mocked.ranges.push([table, start]);
          return query;
        },
        then: (
          resolve: (value: { data: Array<{ workspace_id: string }>; error: null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          const data =
            table === "workspace_accounts"
              ? from < 20_000
                ? Array.from({ length: 1000 }, (_, index) => ({
                    workspace_id: `ws-${from + index}`,
                  }))
                : from === 20_000
                  ? [{ workspace_id: "ws-tail" }]
                  : []
              : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function cronRequest() {
  return new Request("https://app.tryswipein.com/api/cron/agent-loop", {
    headers: { authorization: "Bearer test-secret" },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  mocked.ranges = [];
  mocked.scan.mockReset();
  mocked.scan.mockImplementation(async (_db: unknown, workspaceId: string) => ({
    scanned: 1,
    inserted: 0,
    expired: 0,
    workspaceId,
  }));
  mocked.recover.mockReset();
  mocked.recover.mockResolvedValue(0);
  mocked.alert.mockReset();
  mocked.db = makePagedDb();
});

describe("agent-loop cron workspace fairness", () => {
  test("rotates an oversized workspace list across ticks", () => {
    const workspaces = Array.from({ length: 130 }, (_, index) => `ws-${index}`);
    const seen = new Set<string>();
    const start = new Date("2026-08-01T00:00:00.000Z");
    for (let hour = 0; hour < 3; hour += 1) {
      const now = new Date(start.getTime() + hour * 60 * 60 * 1000);
      for (const workspace of rotateForFairness(workspaces, now, 50)) {
        seen.add(workspace);
      }
    }
    expect(seen.size).toBe(workspaces.length);
  });

  test("the cron uses the fair batch and paginates discovery to completion", () => {
    expect(routeSource).toContain("rotateForFairness");
    expect(routeSource).toContain("MAX_WORKSPACES_PER_TICK");
    expect(routeSource).toContain("for (let from = 0; ; from += PAGE)");
    expect(routeSource).not.toContain("sort().slice(0, 50)");
  });

  test("GET discovers past the old page cap and processes one fair batch", async () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const discovered = [
      ...Array.from({ length: 20_000 }, (_, index) => `ws-${index}`),
      "ws-tail",
    ].sort();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const response = await GET(cronRequest());
      const body = await response.json();
      const scannedIds = mocked.scan.mock.calls.map(([, workspaceId]) =>
        workspaceId,
      );

      expect(response.status).toBe(200);
      expect(mocked.ranges).toContainEqual(["workspace_accounts", 20_000]);
      expect(mocked.scan).toHaveBeenCalledTimes(50);
      expect(body.workspaces).toHaveLength(50);
      expect(scannedIds).toEqual(rotateForFairness(discovered, now, 50));
      expect(scannedIds.some((id) => !discovered.slice(0, 50).includes(id))).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("lease recovery failures alert and fail the cron", async () => {
    mocked.recover.mockRejectedValueOnce(new Error("lease unavailable"));

    const response = await GET(
      new Request(
        "https://app.tryswipein.com/api/cron/agent-loop?workspace=workspace-1",
        { headers: { authorization: "Bearer test-secret" } },
      ),
    );

    expect(response.status).toBe(500);
    expect(mocked.alert).toHaveBeenCalledWith(
      { cron: "agent-loop" },
      expect.objectContaining({
        message: "Draft lease recovery failed for workspace-1: lease unavailable",
      }),
    );
  });
});
