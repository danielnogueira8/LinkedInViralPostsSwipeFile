import { describe, expect, test, vi } from "vitest";

const WORKSPACE_ID = "workspace-1";
const POST_ID = "33333333-3333-4333-8333-333333333333";
const inserted: Array<Record<string, unknown>> = [];
const fetchEmbedCard = vi.fn(async () => ({ text: "Network-fetched full post" }));

function fakeClient() {
  return {
    from(table: string) {
      let inserting = false;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.gte = chain;
      builder.update = chain;
      builder.insert = (value: Record<string, unknown>) => {
        inserting = true;
        inserted.push(value);
        return builder;
      };
      builder.maybeSingle = async () => {
        if (table === "saved_posts") {
          return {
            data: {
              id: POST_ID,
              text: null,
              text_snippet: "Saved snippet fallback",
              author_name: "Creator",
              profile_pic_url: null,
              embed_urn: "urn:li:activity:123",
              activity_id: "123",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      builder.single = async () =>
        inserting
          ? { data: { id: "source-1" }, error: null }
          : { data: null, error: null };
      builder.then = (
        resolve: (value: {
          data: unknown;
          count: number | null;
          error: { message: string } | null;
        }) => unknown,
      ) => {
        if (table === "chat_modeling_sources" && !inserting) {
          return resolve({
            data: null,
            count: null,
            error: { message: "rate limit read unavailable" },
          });
        }
        return resolve({ data: [], count: 0, error: null });
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: WORKSPACE_ID, raw: fakeClient() }),
  trackedAccountIds: vi.fn(async () => []),
}));
vi.mock("@/lib/linkedin-embed-scrape", () => ({ fetchEmbedCard }));
vi.mock("@/lib/linkedin-url", () => ({
  probeEmbedUrn: vi.fn(async () => "urn:li:activity:123"),
}));

const { POST } = await import("@/app/api/model-source/route");

describe("bookmark model-source scrape throttling", () => {
  test("falls back to the saved snippet when the limiter read fails", async () => {
    inserted.length = 0;
    fetchEmbedCard.mockClear();
    const request = new Request("http://test/api/model-source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "bookmark", postId: POST_ID }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, partial: true });
    expect(fetchEmbedCard).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({
      workspace_id: WORKSPACE_ID,
      post_text: "Saved snippet fallback",
      partial: true,
    });
  });
});
