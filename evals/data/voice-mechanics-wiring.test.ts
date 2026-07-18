import { describe, test, expect, vi, beforeEach } from "vitest";
import type { MechanicsFingerprint } from "@/lib/voice-mechanics";

// ---------------------------------------------------------------------------
// runVoiceGeneration computes the mechanics fingerprint from the RAW scraped
// posts and attaches it before persisting — never blocks generation on
// failure. Mirrors voice-generation-interview-preserve.test.ts's harness.
// ---------------------------------------------------------------------------

const runProfileHistory = vi.fn();
const synthesizeVoice = vi.fn();
let profileRow: { profile: Record<string, unknown> } | null = null;
const updates: Array<Record<string, unknown>> = [];

function fakeSupabase() {
  return {
    from() {
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
  synthesizeVoice.mockResolvedValue({ summary: "Punchy and direct.", tone: ["blunt"] });
});

describe("runVoiceGeneration — computes and attaches the mechanics fingerprint", () => {
  test("attaches a fingerprint computed from the raw scraped posts", async () => {
    runProfileHistory.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        text: `this is post number ${i}, written all lowercase like i always do.`,
        reactions: 10,
        comments: 1,
      })),
    );

    await runVoiceGeneration(
      { workspaceId: "ws-1", raw: fakeSupabase() as never },
      "handle1",
      "https://linkedin.com/in/handle1",
      "2026-01-01T00:00:00.000Z",
    );

    const successWrite = updates.find((u) => u.status === "ready");
    expect(successWrite).toBeDefined();
    const profile = successWrite!.profile as Record<string, unknown>;
    const fp = profile.mechanics_fingerprint as MechanicsFingerprint;
    expect(fp).toBeDefined();
    expect(fp.sample_size).toBe(10);
    expect(fp.lowercase_sentence_starts).toBeGreaterThan(0.5);
    // The rest of a fresh synthesis is still present alongside it.
    expect(profile.tone).toEqual(["blunt"]);
  });

  test("never blocks generation on a thin (but valid) sample — profile still saves with a fingerprint", async () => {
    // MIN_VOICE_SAMPLES is 5 — this is the smallest input that still reaches
    // synthesis, exercising the fingerprint computation at its lower bound.
    runProfileHistory.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        text: `a real post number ${i} with enough words in it to count.`,
        reactions: 1,
        comments: 0,
      })),
    );

    await runVoiceGeneration(
      { workspaceId: "ws-1", raw: fakeSupabase() as never },
      "handle1",
      "https://linkedin.com/in/handle1",
      "2026-01-01T00:00:00.000Z",
    );

    const successWrite = updates.find((u) => u.status === "ready");
    expect(successWrite).toBeDefined();
    const profile = successWrite!.profile as Record<string, unknown>;
    expect(profile.mechanics_fingerprint).toBeDefined();
  });
});
