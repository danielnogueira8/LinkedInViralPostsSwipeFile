import { describe, test, expect, vi, beforeEach } from "vitest";
import { creatorStyleQualityWarning, STYLE_LOW_SAMPLE_THRESHOLD } from "@/lib/creator-styles";

// ---------------------------------------------------------------------------
// `description` is a plain user-owned field (editable only via
// creatorStyleUpdateSchema — "never edits the generated profile"). A low-
// sample generation run used to unconditionally overwrite it with a system
// warning: clobbers whatever the user typed, and the warning goes stale
// forever once the user regenerates with more samples (nothing ever cleared
// it). Fix: derive the warning from sample_count at read time instead of
// storing it as text.
// ---------------------------------------------------------------------------

describe("creatorStyleQualityWarning — derived, not stored", () => {
  test("below the threshold → a warning", () => {
    expect(creatorStyleQualityWarning(1)).toMatch(/only 1 post/i);
    expect(creatorStyleQualityWarning(STYLE_LOW_SAMPLE_THRESHOLD - 1)).toMatch(/quality may be weaker/i);
  });

  test("singular vs plural post count", () => {
    expect(creatorStyleQualityWarning(1)).toContain("1 post ");
    expect(creatorStyleQualityWarning(2)).toContain("2 posts ");
  });

  test("at or above the threshold → null (no warning)", () => {
    expect(creatorStyleQualityWarning(STYLE_LOW_SAMPLE_THRESHOLD)).toBeNull();
    expect(creatorStyleQualityWarning(STYLE_LOW_SAMPLE_THRESHOLD + 10)).toBeNull();
  });

  test("zero or negative → null (no data yet, not a quality signal)", () => {
    expect(creatorStyleQualityWarning(0)).toBeNull();
    expect(creatorStyleQualityWarning(-1)).toBeNull();
  });

  // REGRESSION: this is the whole point — the warning tracks the CURRENT
  // sample_count, so it disappears automatically the moment a regenerate
  // crosses the threshold. A stored string could never do this on its own.
  test("REGRESSION: the warning clears itself once sample_count improves — no stale text possible", () => {
    expect(creatorStyleQualityWarning(3)).not.toBeNull();
    expect(creatorStyleQualityWarning(8)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runCreatorStyleGeneration must never write into `description`, low-sample
// or not — that field belongs to the user.
// ---------------------------------------------------------------------------

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn(async () => {});

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...orig, completeChat, logOpenRouterUsage };
});

const updatePayloads: Record<string, unknown>[] = [];

function fakeSupabaseAdmin() {
  return {
    from(table: string) {
      if (table === "saved_posts") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: async () => ({
                  data: [
                    { id: "sp1", text: "A single low-sample post.", post_url: null, reactions: 5 },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "creator_style_profiles") {
        return {
          update: (patch: Record<string, unknown>) => {
            updatePayloads.push(patch);
            return {
              eq: () => ({
                eq: async () => ({ data: null, error: null }),
              }),
            };
          },
        };
      }
      if (table === "creator_style_profile_sources") {
        return {
          delete: () => ({
            eq: () => ({
              eq: async () => ({ data: null, error: null }),
            }),
          }),
          insert: async () => ({ data: null, error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => fakeSupabaseAdmin(),
}));

const { runCreatorStyleGeneration } = await import("@/lib/agent/creator-style-profile");

beforeEach(() => {
  completeChat.mockReset();
  updatePayloads.length = 0;
});

describe("runCreatorStyleGeneration — description is never written by generation", () => {
  test("REGRESSION: a low-sample (below-threshold) run never patches `description`", async () => {
    completeChat.mockResolvedValueOnce({
      toolArgs: {
        summary: "Punchy, direct, contrarian openers.",
        voice_traits: ["blunt", "direct"],
      },
      finishReason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    });

    await runCreatorStyleGeneration({
      workspaceId: "ws1",
      profileId: "style1",
      savedPostIds: ["sp1"], // 1 post — well below STYLE_LOW_SAMPLE_THRESHOLD
    });

    const readyPatch = updatePayloads.find((p) => p.status === "ready");
    expect(readyPatch).toBeDefined();
    expect(readyPatch).not.toHaveProperty("description");
    // sample_count IS persisted — the derived warning reads this, not text.
    expect(readyPatch?.sample_count).toBe(1);
  });
});
