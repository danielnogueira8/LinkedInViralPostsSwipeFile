import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  postPage: 0,
  updateError: { message: "post update failed" },
  remainingError: { message: "remaining count failed" },
}));

const errorResponse = vi.fn((error: unknown) =>
  Response.json(
    { ok: false, error: error instanceof Error ? error.message : "internal" },
    { status: 500 },
  ),
);

vi.mock("@/lib/workspace", () => ({
  errorResponse,
  requireWorkspaceId: vi.fn(async () => "workspace-1"),
}));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: vi.fn(() => ({
    from(table: string) {
      if (table !== "posts") throw new Error(`unexpected table ${table}`);
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        range: async () => {
          const firstPage = state.postPage++ === 0;
          return firstPage
            ? {
                data: [{
                  id: "post-1",
                  text: "A post",
                  post_type: "regular",
                  post_type_detected_via: "legacy",
                }],
                error: null,
              }
            : { data: [], error: null };
        },
        update: () => chain,
        eq: async () => ({ error: state.updateError }),
      };
      return chain;
    },
  })),
}));

const createClient = vi.fn(() => ({
  from(table: string) {
    if (table !== "saved_posts") throw new Error(`unexpected table ${table}`);
    let operation: "select" | "limit" = "select";
    const chain: Record<string, unknown> = {
      select: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => {
        operation = "limit";
        return chain;
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(
          operation === "limit"
            ? { data: [], error: null }
            : { count: null, error: state.remainingError },
        ).then(resolve),
    };
    return chain;
  },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient }));
vi.mock("@/lib/linkedin-embed-scrape", () => ({ fetchEmbedCard: vi.fn() }));
vi.mock("@/lib/linkedin-url", () => ({
  postedAtFromLinkedInId: vi.fn(),
  probeEmbedUrn: vi.fn(),
}));

const postTypesRoute = await import("@/app/api/backfill-post-types/route");
const savedPostsRoute = await import("@/app/api/backfill-saved-posts/route");

beforeEach(() => {
  state.postPage = 0;
  errorResponse.mockClear();
});

describe("backfill routes expose persistence failures", () => {
  test("post-type update failure does not report a successful backfill", async () => {
    const response = await postTypesRoute.POST();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal" });
  });

  test("remaining-count failure does not report zero work remaining", async () => {
    const response = await savedPostsRoute.POST(
      new Request("https://app.test/api/backfill-saved-posts?batch=1"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal" });
  });
});
