import { beforeEach, describe, expect, test, vi } from "vitest";

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn(async () => undefined);

vi.mock("@/lib/openrouter", () => ({
  BACKGROUND_MODEL: "test/background",
  REASONING_MODEL: "test/reasoning",
  completeChat,
  logOpenRouterUsage,
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: vi.fn(),
}));

const { getUserWorkingSummary } = await import(
  "@/lib/agent-loop/user-working-summary"
);
const { USER_WORKING_SUMMARY_KEY } = await import(
  "@/lib/agent-loop/user-working-summary-policy"
);

type TableData = {
  rows?: Array<Record<string, unknown>>;
  single?: Record<string, unknown> | null;
  count?: number;
};

function database(tables: Record<string, TableData>) {
  const writes: Array<Record<string, unknown>> = [];
  const queries: Array<{ table: string; columns?: string; head?: boolean }> = [];

  const client = {
    from(table: string) {
      const query: { table: string; columns?: string; head?: boolean } = {
        table,
      };
      queries.push(query);
      let write: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      chain.select = (
        columns: string,
        options?: { head?: boolean },
      ) => {
        query.columns = columns;
        query.head = options?.head;
        return chain;
      };
      for (const method of ["eq", "or", "order", "limit", "in"]) {
        chain[method] = () => chain;
      }
      chain.upsert = (row: Record<string, unknown>) => {
        write = row;
        writes.push(row);
        return chain;
      };
      chain.maybeSingle = async () => ({
        data: tables[table]?.single ?? null,
        error: null,
      });
      chain.then = (
        resolve: (value: {
          data: unknown;
          count?: number;
          error: null;
        }) => unknown,
      ) =>
        resolve({
          data: query.head
            ? null
            : write
              ? null
              : tables[table]?.rows ?? [],
          ...(query.head ? { count: tables[table]?.count ?? 0 } : {}),
          error: null,
        });
      return chain;
    },
  };

  return { client, writes, queries };
}

const voiceProfile = {
  summary: "Practical founder-led content.",
  audience: {
    primary: "Founder-led service businesses",
    pain_points: [],
    outcomes: [],
  },
  topics: ["Founder-led content", "Positioning"],
  positioning: "Systems over generic advice.",
  tone: ["direct"],
  format_patterns: {
    hook_styles: ["Contrarian belief"],
    structure: "Claim, proof, takeaway.",
    length: "Medium",
    sentence_rhythm: "Short.",
    paragraphing: "Short paragraphs.",
    vocabulary: [],
    punctuation: "Sparse.",
    rhetorical_devices: [],
  },
  signature_moves: ["Rejects the common playbook"],
  do: [],
  dont: [],
  exemplars: ["Real post one.", "Real post two."],
};

function publishedPosts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `post-${index + 1}`,
    body: `Published post ${index + 1} about founder systems.`,
    published_at: `2026-07-${String(20 - index).padStart(2, "0")}T10:00:00.000Z`,
    created_at: `2026-07-${String(20 - index).padStart(2, "0")}T09:00:00.000Z`,
    media_attachments:
      index === 0
        ? [
            {
              id: "image-1",
              name: "proof.png",
              mimeType: "image/png",
              size: 1024,
              type: "image",
              uploadedAt: "2026-07-20T09:00:00.000Z",
            },
          ]
        : [],
  }));
}

beforeEach(() => {
  completeChat.mockReset();
  logOpenRouterUsage.mockClear();
});

describe("getUserWorkingSummary", () => {
  test("grounds the sub-five-post baseline in Voice source exemplars", async () => {
    completeChat.mockResolvedValue({
      text: JSON.stringify({
        insights: [
          {
            label: "Topics",
            finding: "Founder systems are your clearest recurring subject.",
            evidence: "Both saved source posts use a practical system example.",
          },
          {
            label: "Hooks",
            finding: "You open with a direct operating claim.",
            evidence: "Each exemplar puts the practical lesson before context.",
            example: "You do not need more content ideas.",
            exampleKind: "representative",
          },
          {
            label: "Formats",
            finding: "Your short proof-led explanations anchor the Voice baseline.",
            evidence: "The source posts pair one claim with one concrete lesson.",
          },
        ],
      }),
      model: "test/background",
      usage: {},
    });
    const db = database({
      chat_artifacts: { rows: publishedPosts(4), count: 4 },
      voice_profiles: {
        single: {
          profile: voiceProfile,
          source_post_count: 27,
          generated_at: "2026-07-20T10:00:00.000Z",
        },
      },
      settings: { single: null },
    });

    const summary = await getUserWorkingSummary(
      db.client as never,
      "workspace-1",
      { now: new Date("2026-07-23T10:00:00.000Z") },
    );

    expect(summary).toMatchObject({
      source: "voice_profile",
      sourcePostCount: 27,
      analyzedPostCount: 2,
      publishedPostCount: 4,
    });
    expect(summary?.insights.find((item) => item.label === "Hooks")).toMatchObject({
      example: "Real post one.",
      exampleKind: "representative",
    });
    expect(completeChat).toHaveBeenCalledOnce();
    expect(JSON.stringify(completeChat.mock.calls[0]?.[0])).toContain(
      "Real post one.",
    );
    expect(JSON.stringify(completeChat.mock.calls[0]?.[0])).toContain(
      "SOURCE EXEMPLARS",
    );
    expect(db.writes).toContainEqual(
      expect.objectContaining({
        key: USER_WORKING_SUMMARY_KEY,
        workspace_id: "workspace-1",
      }),
    );
  });

  test("uses the latest published posts and metrics at the five-post threshold", async () => {
    completeChat.mockResolvedValue({
      text: JSON.stringify({
        insights: [
          {
            label: "Topics",
            finding: "Founder-system examples are your strongest recurring topic.",
            evidence: "They appear in the highest-engagement posts in this sample.",
          },
          {
            label: "Hooks",
            finding: "Your specific reversals are prompting more discussion.",
            evidence: "The most-commented posts open by rejecting common advice.",
          },
          {
            label: "Formats",
            finding: "Your short proof-led posts carry the clearest signal.",
            evidence: "The strongest posts pair one claim with one concrete example.",
          },
        ],
      }),
      model: "test/background",
      usage: {},
    });
    const db = database({
      chat_artifacts: { rows: publishedPosts(5), count: 5 },
      voice_profiles: { single: { profile: voiceProfile } },
      settings: { single: null },
      post_analytics: {
        rows: [
          {
            artifact_id: "post-1",
            snapshot_date: "2026-07-22",
            impressions: 10_000,
            likes: 200,
            comments: 30,
            shares: 10,
          },
          {
            artifact_id: "post-2",
            snapshot_date: "2026-07-22",
            impressions: 5_000,
            likes: 100,
            comments: 12,
            shares: 4,
          },
        ],
      },
    });

    const summary = await getUserWorkingSummary(
      db.client as never,
      "workspace-1",
      { now: new Date("2026-07-23T10:00:00.000Z") },
    );

    expect(summary).toMatchObject({
      source: "published_posts",
      sourcePostCount: 5,
      analyzedPostCount: 5,
      publishedPostCount: 5,
    });
    expect(completeChat).toHaveBeenCalledOnce();
    expect(JSON.stringify(completeChat.mock.calls[0]?.[0])).toContain(
      "format=image; attachment_count=1",
    );
    expect(summary?.insights.find((item) => item.label === "Hooks")).toMatchObject({
      example: "Published post 1 about founder systems.",
      exampleKind: "best_performing",
    });
    expect(
      db.queries.some((query) => query.table === "voice_profiles"),
    ).toBe(false);
    expect(
      db.queries.some((query) => query.table === "post_analytics"),
    ).toBe(true);
  });

  test("keeps the last published analysis when the weekly model refresh fails", async () => {
    const cached = {
      version: 3,
      source: "published_posts",
      sourcePostCount: 5,
      analyzedPostCount: 5,
      publishedPostCount: 5,
      analyzedAt: "2026-07-10T10:00:00.000Z",
      sourceRevision: "published",
      insights: [
        {
          label: "Topics",
          finding: "Founder-led systems remain your clearest topic signal.",
          evidence: "Three recent posts use concrete operating examples.",
          example: null,
          exampleKind: null,
        },
        {
          label: "Formats",
          finding: "Proof-led posts remain your clearest format signal.",
          evidence: "Three recent posts pair one claim with one example.",
          example: null,
          exampleKind: null,
        },
        {
          label: "Hooks",
          finding: "Contrarian claims remain your clearest opening signal.",
          evidence: "Three recent posts reject familiar operating advice.",
          example: "You do not need more content ideas.",
          exampleKind: "best_performing",
        },
      ],
    };
    completeChat.mockRejectedValue(new Error("provider unavailable"));
    const db = database({
      chat_artifacts: { rows: publishedPosts(5), count: 5 },
      settings: { single: { value: cached } },
      post_analytics: { rows: [] },
    });

    const summary = await getUserWorkingSummary(
      db.client as never,
      "workspace-1",
      {
        forceRefresh: true,
        now: new Date("2026-07-23T10:00:00.000Z"),
      },
    );

    expect(summary).toEqual(cached);
  });

  test("repairs an incomplete category response once", async () => {
    completeChat
      .mockResolvedValueOnce({
        text: JSON.stringify({
          insights: [
            {
              label: "Topics",
              finding: "Founder systems are your clearest recurring subject.",
              evidence: "Three posts use concrete operating examples.",
            },
          ],
        }),
        model: "test/background",
        usage: {},
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          insights: [
            {
              label: "Topics",
              finding: "Founder systems are your clearest recurring subject.",
              evidence: "Three posts use concrete operating examples.",
            },
            {
              label: "Formats",
              finding: "Your image-backed proof posts carry the strongest signal.",
              evidence: "The leading post includes one image and one example.",
            },
            {
              label: "Hooks",
              finding: "Your contrarian claims earn the strongest response.",
              evidence: "The leading posts reject familiar operating advice.",
              example: "I stopped measuring reach. Here is what I track instead.",
              exampleKind: "representative",
            },
          ],
        }),
        model: "test/background",
        usage: {},
      });
    const db = database({
      chat_artifacts: { rows: publishedPosts(5), count: 5 },
      settings: { single: null },
      post_analytics: { rows: [] },
    });

    const summary = await getUserWorkingSummary(
      db.client as never,
      "workspace-1",
      { now: new Date("2026-07-23T10:00:00.000Z") },
    );

    expect(summary?.insights.map((insight) => insight.label)).toEqual([
      "Topics",
      "Formats",
      "Hooks",
    ]);
    expect(completeChat).toHaveBeenCalledTimes(2);
    expect(completeChat.mock.calls[1]?.[0].messages[1].content).toContain(
      "previous response was incomplete",
    );
  });
});
