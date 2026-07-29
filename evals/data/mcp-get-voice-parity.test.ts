import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";
import {
  MIN_CONFIDENT_SAMPLES,
  type MechanicsFingerprint,
} from "@/lib/voice-mechanics";

process.env.CREDENTIAL_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => dbRef.current.client,
}));

vi.mock("@/lib/supabase-scoped", () => ({
  latestRelevantScrapeForService: async () => null,
  trackedAccountIdsForService: async () => [],
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");

type Handler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<unknown>;

function tools() {
  const registered: Record<string, Handler> = {};
  registerSwipeTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered[name] = handler;
    },
  } as never);
  return registered;
}

function extra() {
  return { authInfo: { extra: { workspaceId: "workspace-a" } } };
}

function json(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]
    ?.text;
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

const fingerprint: MechanicsFingerprint = {
  lowercase_sentence_starts: 0.9,
  lowercase_pronoun_i: 0.8,
  all_caps_word_rate: 0,
  em_dash_per_100_words: 0,
  ellipsis_per_100_words: 0,
  exclamation_per_100_words: 0,
  comma_splice_rate: 0,
  emoji_per_post: 0,
  emoji_placement: "none",
  median_sentences_per_paragraph: 1,
  uses_lists_rate: 0,
  dominant_list_marker: null,
  median_words_per_post: 100,
  sample_size: MIN_CONFIDENT_SAMPLES,
};

beforeEach(() => {
  dbRef.current = makeFakeSupabase({
    voice_profiles: {
      single: {
        linkedin_handle: "owner",
        display_name: "Workspace Owner",
        headline: "Founder",
        profile: {
          summary: "Direct and practical.",
          biographical_facts: ["Built a company from scratch."],
          interview_answers: [
            { question: "Private question", answer: "Private raw answer" },
          ],
          interview_context: ["Unverified interview context"],
          mechanics_fingerprint: fingerprint,
        },
        summary: "Direct and practical.",
        source_post_count: 20,
        status: "ready",
        model: "test-model",
        generated_at: "2026-01-01T00:00:00.000Z",
      },
    },
    workspace_knowledge_items: { rows: [] },
  });
});

describe("MCP get_voice parity", () => {
  test("returns canonical model guidance without raw profile-only context", async () => {
    const result = json(await tools().get_voice({}, extra()));
    const voice = result.voice as Record<string, unknown>;
    const profile = voice.profile as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(voice.mechanics_rules).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/lowercase the first letter/i),
        expect.stringMatching(/never use an em dash/i),
      ]),
    );
    expect(voice.backstory_guidance).toContain(
      "Built a company from scratch.",
    );
    expect(profile.biographical_facts).toBeUndefined();
    expect(profile.interview_answers).toBeUndefined();
    expect(profile.interview_context).toBeUndefined();
    expect(profile.mechanics_fingerprint).toBeUndefined();
  });
});
