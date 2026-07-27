import { beforeEach, describe, expect, it, vi } from "vitest";
import { SWIPE_POST_COLS } from "@/lib/swipe-query";

const database = vi.hoisted(() => ({
  rows: {
    chat_artifacts: [] as unknown[],
    agent_opportunities: [] as unknown[],
    posts: [] as unknown[],
  },
  selects: [] as Array<{ table: string; columns: string }>,
  blockedTables: new Set<string>(),
  releases: new Map<string, () => void>(),
}));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: {
      from(table: keyof typeof database.rows) {
        const chain = {
          select(columns: string) {
            database.selects.push({ table, columns });
            return chain;
          },
          eq() {
            return chain;
          },
          is() {
            return chain;
          },
          in() {
            return chain;
          },
          order() {
            return chain;
          },
          limit() {
            return chain;
          },
          then<TResult1 = unknown, TResult2 = never>(
            onfulfilled?:
              | ((value: { data: unknown[]; error: null }) => TResult1)
              | null,
            onrejected?: ((reason: unknown) => TResult2) | null,
          ) {
            const result = {
              data: database.rows[table],
              error: null,
            };
            const ready = database.blockedTables.has(table)
              ? new Promise<typeof result>((resolve) => {
                  database.releases.set(table, () => resolve(result));
                })
              : Promise.resolve(result);
            return ready.then(onfulfilled, onrejected);
          },
        };
        return chain;
      },
    },
  }),
}));

const { GET } = await import("@/app/api/agent/briefing/route");

const opportunity = {
  id: "opportunity-1",
  kind: "viral_post",
  score: 0.92,
  payload: { headline: "Original headline", author: "Ada Lovelace" },
  created_at: "2026-07-22T12:00:00.000Z",
  source_post_id: "post-1",
};

const sourcePost = {
  id: "post-1",
  text: "The full original post",
  post_url: "https://www.linkedin.com/posts/post-1",
  post_type: "lead_magnet",
  posted_at: "2026-07-20T12:00:00.000Z",
  reactions: 1200,
  comments: 42,
  reposts: 9,
  media_type: "image",
  media_urls: ["https://example.com/post.jpg"],
  visual_kind: "graphic",
  viral_score: 2200,
  viral_basis: "relative",
  baseline_score: 1000,
  accounts: [
    {
      name: "Ada Lovelace",
      niche: "Technology",
      linkedin_handle: "ada",
      profile_pic_url: "https://example.com/ada.jpg",
      viral_post_count: 4,
      total_post_count: 12,
    },
  ],
};

describe("GET /api/agent/briefing source-post contract", () => {
  beforeEach(() => {
    database.rows.chat_artifacts = [];
    database.rows.agent_opportunities = [opportunity];
    database.rows.posts = [sourcePost];
    database.selects = [];
    database.blockedTables.clear();
    database.releases.clear();
  });

  it("queries and serializes the complete Swipe File card shape", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    // Two-step fetch: the whole pool is checked with the cheap existence +
    // post_type read, and only the kept slots pay for the full Swipe File
    // card shape (SWIPE_POST_COLS + the accounts join).
    const postsSelects = database.selects.filter(({ table }) => table === "posts");
    expect(postsSelects[0]?.columns).toBe("id, post_type");
    expect(postsSelects.some(({ columns }) => columns === SWIPE_POST_COLS)).toBe(true);
    expect(body.opportunities).toHaveLength(1);
    expect(body.opportunities[0]).toMatchObject({
      id: "opportunity-1",
      is_lead_magnet: true,
      source_post: {
        id: "post-1",
        text: "The full original post",
        media_type: "image",
        media_urls: ["https://example.com/post.jpg"],
        reactions: 1200,
        comments: 42,
        reposts: 9,
        accounts: {
          name: "Ada Lovelace",
          linkedin_handle: "ada",
        },
      },
    });
  });

  it("excludes an opportunity whose source was deleted or malformed", async () => {
    database.rows.posts = [{ id: null, post_type: "regular" }];

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.opportunities).toEqual([]);
  });

  it("starts independent draft and opportunity reads in parallel", async () => {
    database.blockedTables.add("chat_artifacts");

    const responsePromise = GET();
    await vi.waitFor(() => {
      expect(
        database.selects.some(({ table }) => table === "chat_artifacts"),
      ).toBe(true);
    });
    const startedTogether = database.selects.some(
      ({ table }) => table === "agent_opportunities",
    );

    database.releases.get("chat_artifacts")?.();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(startedTogether).toBe(true);
  });
});
