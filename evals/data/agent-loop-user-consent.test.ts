import { beforeEach, describe, expect, test, vi } from "vitest";

const scanAgentOpportunities = vi.fn(async (..._args: unknown[]) => ({
  scanned: 1,
  inserted: 1,
  expired: 0,
}));
const scanTrendOpportunities = vi.fn(async (..._args: unknown[]) => ({
  searched: 0,
  fetched: 0,
  inserted: 0,
  expired: 0,
  skipped: 0,
}));
const actOnOpportunity = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
  draftIds: ["draft-1"],
}));

function queryResult<T>(value: T) {
  const chain: Record<string, unknown> = {};
  const pass = () => chain;
  Object.assign(chain, {
    select: pass,
    eq: pass,
    gte: pass,
    order: pass,
    limit: pass,
    then: (
      resolve: (result: T) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject),
  });
  return chain;
}

const fakeDb = {
  from(table: string) {
    if (table === "agent_opportunities") {
      return queryResult({
        count: 0,
        data: [
          {
            id: "opportunity-1",
            source_post_id: "post-1",
            payload: { headline: "A strong source post" },
          },
        ],
        error: null,
      });
    }
    throw new Error(`Unexpected table: ${table}`);
  },
};

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => fakeDb,
}));
vi.mock("@/lib/agent-loop/scan", () => ({
  scanAgentOpportunities: (...args: unknown[]) =>
    scanAgentOpportunities(...args),
}));
vi.mock("@/lib/agent-loop/trend-radar", () => ({
  scanTrendOpportunities: (...args: unknown[]) =>
    scanTrendOpportunities(...args),
}));
vi.mock("@/lib/agent-loop/act", () => ({
  actOnOpportunity: (...args: unknown[]) => actOnOpportunity(...args),
}));
vi.mock("@/lib/cron-alert", () => ({
  postCronAlert: vi.fn(),
}));
vi.mock("@/lib/supabase-scoped", () => ({
  latestRelevantScrape: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({
  errorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: (error as Error)?.message ?? "Unexpected error" },
      { status: 500 },
    ),
}));

const { GET } = await import("@/app/api/cron/agent-loop/route");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-secret";
});

describe("daily agent discovery respects user drafting consent", () => {
  test("a daily scan may suggest source posts but never drafts them automatically", async () => {
    const response = await GET(
      new Request(
        "https://app.tryswipein.com/api/cron/agent-loop?workspace=workspace-1",
        { headers: { authorization: "Bearer test-secret" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(scanAgentOpportunities).toHaveBeenCalledWith(
      fakeDb,
      "workspace-1",
    );
    expect(actOnOpportunity).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      ok: true,
      workspaces: [
        {
          workspaceId: "workspace-1",
          scanned: 1,
          inserted: 1,
          expired: 0,
        },
      ],
    });
  });
});
