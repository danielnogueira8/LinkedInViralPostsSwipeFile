import { describe, test, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAgentInboxEvidenceLoader,
  rankKnowledgeEvidence,
  rankSourcePostEvidence,
} from "@/lib/agent-inbox/evidence";

const { trackedAccountIds, discoverSourcePosts } = vi.hoisted(() => ({
  trackedAccountIds: vi.fn(),
  discoverSourcePosts: vi.fn(),
}));

vi.mock("@/lib/supabase-scoped", () => ({ trackedAccountIds }));
vi.mock("@/lib/source-post-discovery", () => ({ discoverSourcePosts }));

// The legacy artifact pipeline titled drafts with the body's first 60 chars
// sliced mid-word ("…before your content ge"), and the evidence loader
// re-sliced bodies mid-sentence ("…analytics. Here's"). Both fragments landed
// verbatim in the draft prompt (lib/agent-inbox/prompt.ts). These tests pin
// the word/sentence-boundary behavior that replaced the raw slices.

const PROFILE_BODY =
  "Your LinkedIn profile can kill a sale before your content gets a chance. I don't hide behind a clever headline. I don't fill my About section with empty claims. I don't send profile visitors hunting for the offer. And you don't need to either; your profile only needs to: 1. Name the buyer you help. 2. Explain the problem you solve. 3. Show why they should trust you. 4. Give them one clear next step. That's how profile views turn into DMs instead of disappearing into LinkedIn's analytics. Here's the rest of the post that should never dangle into the prompt.";

function mockDb(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        neq: () => query,
        gte: () => query,
        gt: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

async function loadRecent(rows: Array<Record<string, unknown>>) {
  const loader = createAgentInboxEvidenceLoader(
    mockDb({ chat_artifacts: rows }),
  );
  const bundle = await loader({
    workspaceId: "ws-1",
    preferences: { topics: [], newsSensitivity: "medium" } as never,
    missingLanes: [],
    now: new Date("2026-07-28T12:00:00Z"),
  });
  return bundle.recent ?? [];
}

describe("agent inbox evidence — recent posts", () => {
  test("recovers a legacy mid-word-truncated title from the body", async () => {
    const [entry] = await loadRecent([
      {
        id: "art-1",
        title: "Your LinkedIn profile can kill a sale before your content ge",
        body: PROFILE_BODY,
        created_at: "2026-07-20T10:00:00Z",
      },
    ]);
    expect(entry.label).toBe(
      "Your LinkedIn profile can kill a sale before your content gets a chance.",
    );
  });

  test("keeps a custom title that is not a prefix of the body", async () => {
    const [entry] = await loadRecent([
      {
        id: "art-2",
        title: "Profile teardown framework",
        body: PROFILE_BODY,
        created_at: "2026-07-20T10:00:00Z",
      },
    ]);
    expect(entry.label).toBe("Profile teardown framework");
  });

  test("the detail ends at a sentence boundary — no dangling opener", async () => {
    const [entry] = await loadRecent([
      {
        id: "art-3",
        title: "Custom name",
        body: PROFILE_BODY,
        created_at: "2026-07-20T10:00:00Z",
      },
    ]);
    expect(entry.detail.length).toBeLessThanOrEqual(500);
    expect(entry.detail.endsWith("Here's")).toBe(false);
    expect(/[.!?…]$/.test(entry.detail)).toBe(true);
  });

  test("falls back to the body's first line when there is no title", async () => {
    const [entry] = await loadRecent([
      {
        id: "art-4",
        title: null,
        body: "Short opening line.\n\nThe rest of the post.",
        created_at: "2026-07-20T10:00:00Z",
      },
    ]);
    expect(entry.label).toBe("Short opening line.");
  });
});

describe("agent inbox evidence — fresh news only", () => {
  const NEWS_NOW = new Date("2026-07-28T12:00:00Z");
  const poolRow = (results: Array<Record<string, unknown>>) => ({
    results,
    expires_at: "2027-01-01T00:00:00Z",
  });
  const story = (title: string, url: string, publishedAt: string) => ({
    title,
    summary: `${title} summary`,
    url,
    source: "example.com",
    published_at: publishedAt,
  });

  async function loadNews(
    results: Array<Record<string, unknown>>,
    usedIdeas: Array<Record<string, unknown>>,
    missingLanes: Array<"newsjacking"> = ["newsjacking"],
  ) {
    const loader = createAgentInboxEvidenceLoader(
      mockDb({
        chat_artifacts: [],
        workspace_learning_snapshots: [],
        workspace_knowledge_items: [],
        agent_news_pool: [poolRow(results)],
        agent_inbox_ideas: usedIdeas,
      }),
    );
    const bundle = await loader({
      workspaceId: "ws-1",
      preferences: { topics: ["AI"], newsSensitivity: "standard" } as never,
      missingLanes,
      now: NEWS_NOW,
    });
    return bundle.news;
  }

  test("a story already pitched in the last days is excluded from the pool", async () => {
    const news = await loadNews(
      [
        story("Already pitched story", "https://example.com/old", "2026-07-27T10:00:00Z"),
        story("Fresh story", "https://example.com/fresh", "2026-07-27T11:00:00Z"),
      ],
      [{ source_url: "https://example.com/old", source_ref: null }],
    );
    expect(news.map((entry) => entry.label)).toEqual(["Fresh story"]);
  });

  test("a story already pitched by source ref is excluded too", async () => {
    const news = await loadNews(
      [story("Already pitched story", null as never, "2026-07-27T10:00:00Z")],
      [{ source_url: null, source_ref: "example.com" }],
    );
    expect(news).toEqual([]);
  });

});

describe("agent inbox evidence — Source Posts", () => {
  test("retrieves source structures that are compatible with the strongest anchor", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const ranked = rankSourcePostEvidence(
      [
        {
          kind: "source_post",
          role: "inspiration",
          label: "Recent generic post",
          detail: "A broad post about productivity and meetings at work.",
          ref: "generic",
          publishedAt: "2026-08-01T10:00:00Z",
        },
        {
          kind: "source_post",
          role: "inspiration",
          label: "Customer-loss story",
          detail:
            "A customer chose a cheaper product after an unclear sales pitch, changing the buying decision.",
          ref: "matched",
          publishedAt: "2026-07-20T10:00:00Z",
        },
      ],
      now,
      ["founder content"],
      [
        {
          kind: "knowledge",
          role: "anchor",
          label: "A verified customer loss",
          detail:
            "A customer chose a cheaper tool after our unclear pitch. The loss changed how we explain the buying decision.",
          subtype: "story",
        },
      ],
    );
    expect(ranked[0].ref).toBe("matched");
  });

  test("prefers complete proof and story anchors over short generic beliefs", () => {
    const ranked = rankKnowledgeEvidence([
      {
        kind: "knowledge",
        role: "anchor",
        label: "Generic belief",
        detail: "Consistency matters.",
        subtype: "belief",
      },
      {
        kind: "knowledge",
        role: "anchor",
        label: "Measured result",
        detail:
          "We changed the client onboarding decision after three failed launches, then reduced setup time by 40% across 12 customers because the new process exposed the missing approval step.",
        subtype: "proof",
      },
    ]);
    expect(ranked[0].label).toBe("Measured result");
  });

  test("loads tracked and bookmarked posts as inspiration while keeping drafts as context", async () => {
    trackedAccountIds.mockResolvedValue(["account-1"]);
    discoverSourcePosts.mockResolvedValue({
      rows: [
        {
          id: "swipe-1",
          text: Array.from(
            { length: 45 },
            (_, index) => `Tracked source sentence ${index + 1}.`,
          ).join(" "),
          post_url: "https://linkedin.com/posts/swipe-1",
          posted_at: "2026-07-30T10:00:00.000Z",
          reactions: 120,
          comments: 20,
          accounts: { name: "Tracked Creator" },
        },
      ],
      nextOffset: null,
    });
    const loader = createAgentInboxEvidenceLoader(
      mockDb({
        chat_artifacts: [
          {
            id: "draft-1",
            title: "My recent draft",
            body: "A recent draft for context.",
            created_at: "2026-07-30T09:00:00Z",
          },
        ],
        workspace_learning_snapshots: [
          {
            signals: [
              {
                kind: "hook",
                label: "Specific hooks outperform generic openings",
                score: 0.82,
                confidence: 0.8,
                sampleSize: 8,
              },
            ],
          },
        ],
        workspace_knowledge_items: [
          {
            id: "knowledge-1",
            kind: "story",
            title: "A verified customer loss",
            content: {
              summary: "A customer chose a cheaper tool after our unclear pitch.",
              details: "The loss changed how we explain the buying decision.",
            },
          },
        ],
        saved_posts: [
          {
            id: "bookmark-1",
            text: Array.from(
              { length: 45 },
              (_, index) => `Bookmarked source sentence ${index + 1}.`,
            ).join(" "),
            text_snippet: null,
            post_url: "https://linkedin.com/posts/bookmark-1",
            posted_at: "2026-07-31T10:00:00.000Z",
            saved_at: "2026-07-31T11:00:00.000Z",
            author_name: "Bookmarked Creator",
            reactions: 80,
            comments: 10,
          },
        ],
      }),
    );

    const bundle = await loader({
      workspaceId: "ws-1",
      preferences: { topics: ["founder content"], newsSensitivity: "standard" } as never,
      missingLanes: ["personal_story", "educational"],
      now: new Date("2026-08-01T12:00:00Z"),
    });

    expect(bundle.sourcePosts.map((entry) => entry.sourceOrigin)).toEqual([
      "bookmark",
      "swipe",
    ]);
    expect(bundle.sourcePosts.every((entry) => entry.role === "inspiration")).toBe(
      true,
    );
    expect(bundle.recent?.[0]).toMatchObject({
      kind: "draft",
      role: "context",
    });
    expect(bundle.knowledge[0]).toMatchObject({
      kind: "knowledge",
      role: "anchor",
      subtype: "story",
    });
    expect(bundle.learning[0]).toMatchObject({
      kind: "performance",
      role: "anchor",
    });
    expect(discoverSourcePosts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountIds: ["account-1"], workspaceId: "ws-1" }),
    );
  });
});
