import { beforeEach, expect, test, vi } from "vitest";

const calls: Array<{ workspaceId: string; input: Record<string, unknown> }> =
  [];

vi.mock("@/lib/tracked-creators-supabase", () => ({
  createWorkspaceAccountWriter: () => ({}),
  createSupabaseTrackedCreatorsRepository: (
    _db: unknown,
    workspaceId: string,
  ) => ({ workspaceId }),
}));

vi.mock("@/lib/tracked-creators", () => {
  class TrackedCreatorError extends Error {
    code = "test";
    status = 400;
  }
  class TrackedCreators {
    private workspaceId: string;
    constructor(repository: { workspaceId: string }) {
      this.workspaceId = repository.workspaceId;
    }
    async add(input: Record<string, unknown>) {
      calls.push({ workspaceId: this.workspaceId, input });
      return {
        account: {
          id: "account-1",
          name: "Creator",
          linkedinHandle: "creator",
          profileUrl: "https://www.linkedin.com/in/creator",
          niche: null,
          source: "manual",
          syncedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
        },
        created: true,
        metaResolved: false,
      };
    }
  }
  return { TrackedCreatorError, TrackedCreators };
});

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-web",
    raw: {},
    trackAccount: vi.fn(),
    untrackAccount: vi.fn(),
    workspaceAccountsSelect: vi.fn(),
  }),
  trackedAccountIds: async () => [],
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({}),
}));

vi.mock("@/lib/linkedin-url", async (original) => {
  const actual = await original<typeof import("@/lib/linkedin-url")>();
  return {
    ...actual,
    fetchProfileMeta: async () => ({ name: null, picUrl: null }),
  };
});

const { POST } = await import("@/app/api/accounts/manual/route");
const { registerSwipeTools } = await import("@/lib/mcp/register");

type Handler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<unknown>;

beforeEach(() => {
  calls.length = 0;
});

test("web and MCP adds invoke the same tenant-bound TrackedCreators behavior", async () => {
  const tools: Record<string, Handler> = {};
  registerSwipeTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  } as never);

  const web = await POST(
    new Request("http://test/api/accounts/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_url: "linkedin.com/in/creator" }),
    }),
  );
  const mcp = await tools.add_account(
    {
      profile_url: "linkedin.com/in/creator",
      name: "Creator",
      niche: "AI",
    },
    { authInfo: { extra: { workspaceId: "workspace-mcp" } } },
  );

  expect(web.status).toBe(200);
  expect((mcp as { isError?: boolean }).isError).not.toBe(true);
  expect(calls).toEqual([
    expect.objectContaining({
      workspaceId: "workspace-web",
      input: expect.objectContaining({
        profileUrl: "linkedin.com/in/creator",
        duplicate: "reject",
      }),
    }),
    expect.objectContaining({
      workspaceId: "workspace-mcp",
      input: expect.objectContaining({
        profileUrl: "linkedin.com/in/creator",
        duplicate: "return_existing",
      }),
    }),
  ]);
});
