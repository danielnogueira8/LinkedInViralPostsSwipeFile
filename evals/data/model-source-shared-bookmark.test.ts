import { describe, expect, test, vi } from "vitest";

const CALLER_WORKSPACE = "workspace-caller";
const OWNER_WORKSPACE = "workspace-owner";
const SHARE_ID = "11111111-1111-4111-8111-111111111111";
const POST_ID = "22222222-2222-4222-8222-222222222222";
const inserted: Array<Record<string, unknown>> = [];
const savedPostWorkspaceFilters: string[] = [];

function fakeClient() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.gte = chain;
      builder.eq = (column: string, value: unknown) => {
        filters[column] = value;
        if (table === "saved_posts" && column === "workspace_id") {
          savedPostWorkspaceFilters.push(String(value));
        }
        return builder;
      };
      builder.insert = (value: Record<string, unknown>) => {
        inserted.push(value);
        return builder;
      };
      builder.update = chain;
      builder.maybeSingle = async () => {
        if (
          table === "saved_posts" &&
          filters.workspace_id === OWNER_WORKSPACE &&
          filters.id === POST_ID
        ) {
          return {
            data: {
              id: POST_ID,
              text: "A complete shared bookmark post.",
              text_snippet: null,
              author_name: "Shared Author",
              profile_pic_url: null,
              embed_urn: "urn:li:activity:123",
              activity_id: "123",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      builder.single = async () => ({ data: { id: "source-1" }, error: null });
      builder.then = (
        resolve: (value: { data: unknown; count: number; error: null }) => unknown,
      ) => resolve({ data: [], count: 0, error: null });
      return builder;
    },
  };
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: CALLER_WORKSPACE, raw: fakeClient() }),
  trackedAccountIds: vi.fn(async () => []),
}));
vi.mock("@/lib/shared-bookmarks", () => ({
  resolveActiveLibrary: vi.fn(async (shareId: string | null) =>
    shareId === SHARE_ID
      ? {
          kind: "shared",
          workspaceId: OWNER_WORKSPACE,
          shareId: SHARE_ID,
          userId: "user-1",
        }
      : { kind: "own", workspaceId: CALLER_WORKSPACE, userId: "user-1" },
  ),
  SharedBookmarkAccessError: class SharedBookmarkAccessError extends Error {},
}));
vi.mock("@/lib/linkedin-embed-scrape", () => ({ fetchEmbedCard: vi.fn() }));
vi.mock("@/lib/linkedin-url", () => ({ probeEmbedUrn: vi.fn() }));

const { POST } = await import("@/app/api/model-source/route");

describe("shared bookmark model sources", () => {
  test("resolves the bookmark from the accepted library owner's workspace", async () => {
    inserted.length = 0;
    savedPostWorkspaceFilters.length = 0;
    const request = new Request("http://test/api/model-source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "bookmark",
        postId: POST_ID,
        shareId: SHARE_ID,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, id: "source-1" });
    expect(savedPostWorkspaceFilters).toContain(OWNER_WORKSPACE);
    expect(inserted[0]).toMatchObject({
      workspace_id: CALLER_WORKSPACE,
      source: "bookmark",
      source_post_id: POST_ID,
    });
  });
});
