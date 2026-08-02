import { describe, expect, test, vi, beforeEach } from "vitest";

const buildExemplarBlock = vi.hoisted(() => vi.fn());
const curatedRows = vi.hoisted(
  () =>
    ({
      value: [] as Array<Record<string, unknown>>,
    }),
);

vi.mock("@/lib/batch/exemplar-retrieval", () => ({
  buildExemplarBlock,
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = () => chain;
      chain.then = (resolve: (value: unknown) => unknown) =>
        resolve({ data: curatedRows.value, error: null });
      return chain;
    },
  }),
}));

const {
  LINKEDIN_NATIVE_GUIDANCE_MAX_CHARS,
  LINKEDIN_NATIVE_MIN_SIMILARITY,
  resolveLinkedInNativeGuidance,
} = await import(
  "@/lib/agent/linkedin-native-guidance"
);

beforeEach(() => {
  buildExemplarBlock.mockReset();
  curatedRows.value = [];
});

describe("resolveLinkedInNativeGuidance", () => {
  test("returns the selected format plus semantic LinkedIn exemplars", async () => {
    buildExemplarBlock.mockResolvedValue({
      block: "SEMANTIC EXEMPLAR BLOCK",
      viralCount: 2,
      mediocreCount: 0,
      exemplars: [
        {
          postId: "post-1",
          similarity: 0.91,
          lane: "viral",
          text: "A real LinkedIn-native example.",
        },
      ],
    });

    const guidance = await resolveLinkedInNativeGuidance({
      workspaceId: "workspace-1",
      instruction: "Write an original post about founder-led sales.",
    });

    expect(guidance.retrievalMode).toBe("semantic");
    expect(guidance.promptBlock).toContain("SEMANTIC EXEMPLAR BLOCK");
    expect(guidance.promptBlock).toContain(
      "Do NOT tell the user which format was selected",
    );
    expect(guidance.exemplars).toEqual([
      expect.objectContaining({
        postId: "post-1",
        source: "semantic",
      }),
    ]);
    expect(buildExemplarBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        postType: "regular",
        includeMediocre: false,
        minSimilarity: LINKEDIN_NATIVE_MIN_SIMILARITY,
      }),
    );
  });

  test("does not retrieve semantic exemplars when the kill switch is disabled", async () => {
    const previous = process.env.LINKEDIN_NATIVE_RAG_ENABLED;
    process.env.LINKEDIN_NATIVE_RAG_ENABLED = "false";

    try {
      const guidance = await resolveLinkedInNativeGuidance({
        workspaceId: "workspace-1",
        instruction: "Write an original post about founder-led sales.",
      });

      expect(guidance.retrievalMode).toBe("disabled");
      expect(guidance.exemplars).toEqual([]);
      expect(buildExemplarBlock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.LINKEDIN_NATIVE_RAG_ENABLED;
      else process.env.LINKEDIN_NATIVE_RAG_ENABLED = previous;
    }
  });

  test("honors an explicit source-discovery opt-out", async () => {
    const guidance = await resolveLinkedInNativeGuidance({
      workspaceId: "workspace-1",
      instruction:
        "Write an original post about founder-led sales. Do not search or use sources.",
    });

    expect(guidance.retrievalMode).toBe("opted_out");
    expect(guidance.exemplars).toEqual([]);
    expect(buildExemplarBlock).not.toHaveBeenCalled();
  });

  test("falls back to curated format exemplars when semantic retrieval is empty", async () => {
    buildExemplarBlock.mockResolvedValue({
      block: "",
      viralCount: 0,
      mediocreCount: 0,
      exemplars: [],
    });
    curatedRows.value = [
      {
        id: "71837d68-6a8f-47a0-a116-09390a6674c7",
        text: "A curated LinkedIn example.",
        reactions: 100,
        comments: 10,
        reposts: 1,
        viral_score: 4,
        accounts: { name: "Creator", niche: "SaaS" },
      },
    ];

    const guidance = await resolveLinkedInNativeGuidance({
      workspaceId: "workspace-1",
      instruction: "Write an original post about a system breakdown.",
      forcedFormatId: "lead_magnet_system_breakdown",
    });

    expect(guidance.retrievalMode).toBe("curated");
    expect(guidance.promptBlock).toContain("A curated LinkedIn example.");
    expect(guidance.exemplars).toEqual([
      expect.objectContaining({
        postId: "71837d68-6a8f-47a0-a116-09390a6674c7",
        source: "curated",
      }),
    ]);
  });

  test("falls back to deterministic rules when both retrieval lanes are empty", async () => {
    buildExemplarBlock.mockResolvedValue({
      block: "",
      viralCount: 0,
      mediocreCount: 0,
      exemplars: [],
    });

    const guidance = await resolveLinkedInNativeGuidance({
      workspaceId: "workspace-1",
      instruction: "Write an original post about founder-led sales.",
    });

    expect(guidance.retrievalMode).toBe("rules_only");
    expect(guidance.exemplars).toEqual([]);
    expect(guidance.promptBlock).toContain("Structure to model:");
  });

  test("bounds oversized semantic examples without cutting an example envelope", async () => {
    buildExemplarBlock.mockResolvedValue({
      block: `For reference, here is how similar topics have performed\n${"x".repeat(LINKEDIN_NATIVE_GUIDANCE_MAX_CHARS)}\n--- LINKEDIN VIRAL EXEMPLAR 1 ---\nunsafe`,
      viralCount: 1,
      mediocreCount: 0,
      exemplars: [
        {
          postId: "post-oversized",
          similarity: 0.8,
          lane: "viral",
          text: "unsafe",
        },
      ],
    });

    const guidance = await resolveLinkedInNativeGuidance({
      workspaceId: "workspace-1",
      instruction: "Write an original post about founder-led sales.",
    });

    expect(guidance.promptBlock.length).toBeLessThanOrEqual(
      LINKEDIN_NATIVE_GUIDANCE_MAX_CHARS,
    );
    expect(guidance.promptBlock).not.toContain("LINKEDIN VIRAL EXEMPLAR");
  });
});
