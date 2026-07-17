import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// runVoiceGeneration's success write used to overwrite the ENTIRE `profile`
// column with a freshly synthesized profile — one that never carries
// interview_answers/interview_context, since synthesizeVoice never receives
// them. If a context interview (app/api/voice/interview/route.ts, which
// correctly reads-merges-writes) completed WHILE a generation was still in
// flight, the generation's later write would silently erase the interview
// data. This mirrors the fix: re-read the row's current interview fields
// right before the success write and carry them forward.
// ---------------------------------------------------------------------------

const runProfileHistory = vi.fn();
const synthesizeVoice = vi.fn();
let profileRow: { profile: Record<string, unknown> } | null = null;
const updates: Array<Record<string, unknown>> = [];

function fakeSupabase() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        maybeSingle: () => Promise.resolve({ data: profileRow, error: null }),
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          return {
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  select: async () => ({ data: [{ id: "vp-1" }], error: null }),
                }),
              }),
            }),
          };
        },
      });
      return builder;
    },
  };
}

vi.mock("@/lib/apify", () => ({
  runProfileHistory,
  pickProfileMeta: () => ({ name: "Test", avatar_url: null, headline: null }),
}));
vi.mock("@/lib/claude", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/claude")>();
  return { ...orig, synthesizeVoice };
});

const { runVoiceGeneration } = await import("@/lib/voice-generation");

beforeEach(() => {
  updates.length = 0;
  profileRow = null;
  runProfileHistory.mockReset();
  synthesizeVoice.mockReset();
  runProfileHistory.mockResolvedValue(
    Array.from({ length: 6 }, (_, i) => ({
      text: `Post number ${i} with real content in it.`,
      reactions: 10,
      comments: 1,
    })),
  );
  synthesizeVoice.mockResolvedValue({
    summary: "Punchy and direct.",
    tone: ["blunt"],
  });
});

describe("runVoiceGeneration — preserves interview data written mid-run", () => {
  test("carries forward interview_answers/interview_context saved by a concurrent interview", async () => {
    profileRow = {
      profile: {
        interview_answers: [{ question: "q1", answer: "a1" }],
        interview_context: ["writes in short punchy sentences"],
      },
    };

    await runVoiceGeneration(
      { workspaceId: "ws-1", raw: fakeSupabase() as never },
      "handle1",
      "https://linkedin.com/in/handle1",
      "2026-01-01T00:00:00.000Z",
    );

    const successWrite = updates.find((u) => u.status === "ready");
    expect(successWrite).toBeDefined();
    const profile = successWrite!.profile as Record<string, unknown>;
    expect(profile.interview_answers).toEqual([{ question: "q1", answer: "a1" }]);
    expect(profile.interview_context).toEqual(["writes in short punchy sentences"]);
    // The freshly synthesized fields are still present alongside the preserved ones.
    expect(profile.tone).toEqual(["blunt"]);
  });

  test("no prior interview data on the row → nothing to preserve, no crash", async () => {
    profileRow = { profile: { tone: ["old"] } };

    await runVoiceGeneration(
      { workspaceId: "ws-1", raw: fakeSupabase() as never },
      "handle1",
      "https://linkedin.com/in/handle1",
      "2026-01-01T00:00:00.000Z",
    );

    const successWrite = updates.find((u) => u.status === "ready");
    expect(successWrite).toBeDefined();
    const profile = successWrite!.profile as Record<string, unknown>;
    expect(profile.interview_answers).toBeUndefined();
    expect(profile.interview_context).toBeUndefined();
  });
});
