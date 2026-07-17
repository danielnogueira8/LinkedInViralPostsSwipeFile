import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// runCreatorStyleGeneration's completion write used to be an unconditional
// .update().eq("id", ...) — whichever run finished LAST won, even if a newer
// regenerate had already superseded it (e.g. after stale-recovery flipped a
// dead run to 'failed' and a fresh regenerate started). This mirrors the fix:
// every write is now conditioned on the generating_started_at value (runToken)
// the caller was handed when it claimed the row, matching runVoiceGeneration's
// pending_started_at CAS guard.
// ---------------------------------------------------------------------------

const updates: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];
let updateMatches = true;

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let mode: "select" | "update" | "delete" | "insert" = "select";
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        in: chain,
        limit: chain,
        order: chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        update: (patch: Record<string, unknown>) => {
          mode = "update";
          if (table === "creator_style_profiles") {
            (builder as { __pendingUpdate?: Record<string, unknown> }).__pendingUpdate = patch;
          }
          return builder;
        },
        delete: () => {
          mode = "delete";
          return builder;
        },
        insert: () => {
          mode = "insert";
          return builder;
        },
        then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
          if (table === "saved_posts" && mode === "select") {
            return resolve({
              data: [
                {
                  id: "post-1",
                  text: "A punchy post with a contrarian opener and a clear structure.",
                  text_snippet: null,
                  post_url: "https://linkedin.com/post-1",
                  reactions: 100,
                },
              ],
              error: null,
            });
          }
          if (mode === "update" && table === "creator_style_profiles") {
            const patch = (builder as { __pendingUpdate?: Record<string, unknown> }).__pendingUpdate;
            if (patch) updates.push({ patch, filters: { ...filters } });
            return resolve({
              data: updateMatches ? [{ id: "style-1" }] : [],
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      });
      return builder;
    },
  };
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabase() }));
vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...orig,
    completeChat: vi.fn(async () => ({
      toolArgs: {
        summary: "Punchy, direct, short paragraphs with a contrarian opener.",
        voice_traits: ["blunt", "direct"],
      },
      finishReason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    })),
    logOpenRouterUsage: vi.fn(async () => {}),
  };
});

const { runCreatorStyleGeneration } = await import("@/lib/agent/creator-style-profile");

beforeEach(() => {
  updates.length = 0;
  updateMatches = true;
});

describe("runCreatorStyleGeneration — run-identity CAS guard", () => {
  test("the success write is conditioned on the caller's runToken", async () => {
    await runCreatorStyleGeneration({
      workspaceId: "ws-1",
      profileId: "style-1",
      savedPostIds: ["post-1"],
      runToken: "2026-01-01T00:00:00.000Z",
    });

    const successWrite = updates.find((u) => u.patch.status === "ready");
    expect(successWrite).toBeDefined();
    expect(successWrite!.filters.generating_started_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("a superseded run's late write matches zero rows and does not throw", async () => {
    updateMatches = false; // simulates a newer run having already changed generating_started_at

    await expect(
      runCreatorStyleGeneration({
        workspaceId: "ws-1",
        profileId: "style-1",
        savedPostIds: ["post-1"],
        runToken: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();

    const successWrite = updates.find((u) => u.patch.status === "ready");
    expect(successWrite).toBeDefined();
    expect(successWrite!.filters.generating_started_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("no runToken (legacy job) skips the CAS filter entirely", async () => {
    await runCreatorStyleGeneration({
      workspaceId: "ws-1",
      profileId: "style-1",
      savedPostIds: ["post-1"],
      runToken: null,
    });

    const successWrite = updates.find((u) => u.patch.status === "ready");
    expect(successWrite).toBeDefined();
    expect(successWrite!.filters.generating_started_at).toBeUndefined();
  });
});
