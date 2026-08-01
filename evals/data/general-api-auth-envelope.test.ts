import { describe, expect, test, vi } from "vitest";

class NoWorkspaceError extends Error {
  constructor() {
    super("You're not signed in.");
  }
}

const requireWorkspaceId = vi.fn(async () => {
  throw new NoWorkspaceError();
});
const errorResponse = vi.fn((error: unknown) =>
  Response.json(
    { ok: false, error: error instanceof Error ? error.message : "internal" },
    { status: error instanceof NoWorkspaceError ? 401 : 500 },
  ),
);

vi.mock("@/lib/workspace", () => ({
  NoWorkspaceError,
  errorResponse,
  requireWorkspaceId,
}));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: vi.fn(() => ({ from: vi.fn() })) }));
vi.mock("@/lib/claude", () => ({ extractHookWithClaude: vi.fn() }));
vi.mock("@/lib/hooks", () => ({
  extractHookHeuristic: vi.fn(),
  qualifiesForHookLibrary: vi.fn(),
  normalizeHookForDedupe: vi.fn(),
}));
vi.mock("@/lib/db-paginate", () => ({
  idChunks: (ids: string[]) => [ids],
  selectAllRows: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/linkedin-embed-scrape", () => ({ fetchEmbedCard: vi.fn() }));
vi.mock("@/lib/linkedin-url", () => ({
  postedAtFromLinkedInId: vi.fn(),
  probeEmbedUrn: vi.fn(),
}));

const hooksRoute = await import("@/app/api/backfill-hooks/route");
const postTypesRoute = await import("@/app/api/backfill-post-types/route");
const savedPostsRoute = await import("@/app/api/backfill-saved-posts/route");

describe("admin backfill routes preserve the JSON auth error envelope", () => {
  test.each([
    ["hooks", () => hooksRoute.POST(new Request("https://app.test/api/backfill-hooks"))],
    ["post types", () => postTypesRoute.POST()],
    ["saved posts", () => savedPostsRoute.POST(new Request("https://app.test/api/backfill-saved-posts"))],
  ])("%s returns 401 for a signed-out caller", async (_label, invoke) => {
    const response = await invoke();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "You're not signed in." });
  });
});
