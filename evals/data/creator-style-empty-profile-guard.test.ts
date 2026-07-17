import { describe, test, expect, vi, beforeEach } from "vitest";
import { isUsableCreatorStyleProfile, type CreatorStyleProfile } from "@/lib/creator-styles";

// ---------------------------------------------------------------------------
// sanitizeCreatorStyleProfile is a PURE, non-throwing coercion (existing rows
// read through it too) — {} in is {summary:"",...} out, never a throw. That
// means a model call returning an empty/near-empty forced-tool payload used
// to sail through sanitization looking "valid" and get persisted as a ready
// style with nothing useful for buildStylePromptBlock to inject beyond the
// fixed anti-copying footer. isUsableCreatorStyleProfile is the SEMANTIC gate
// applied at the generation call site on top of sanitization.
// ---------------------------------------------------------------------------

const EMPTY: CreatorStyleProfile = {
  summary: "",
  voice_traits: [],
  hook_patterns: [],
  structure_patterns: [],
  formatting_rules: [],
  rhythm_rules: [],
  cta_patterns: [],
  post_format_preferences: [],
  avoid_copying: [],
};

describe("isUsableCreatorStyleProfile", () => {
  test("a fully empty profile ({} sanitized) is NOT usable", () => {
    expect(isUsableCreatorStyleProfile(EMPTY)).toBe(false);
  });

  test("a summary with no mechanics is NOT usable", () => {
    expect(
      isUsableCreatorStyleProfile({
        ...EMPTY,
        summary: "Punchy, direct, short paragraphs.",
      }),
    ).toBe(false);
  });

  test("mechanics with no real summary is NOT usable", () => {
    expect(
      isUsableCreatorStyleProfile({
        ...EMPTY,
        summary: "x", // below the min length
        voice_traits: ["blunt", "direct"],
      }),
    ).toBe(false);
  });

  test("a real summary + 2+ mechanics IS usable", () => {
    expect(
      isUsableCreatorStyleProfile({
        ...EMPTY,
        summary: "Punchy, direct, short paragraphs with a contrarian opener.",
        voice_traits: ["blunt", "direct"],
      }),
    ).toBe(true);
  });

  test("a single hook_pattern + formatting_rule counts as 2 mechanics", () => {
    expect(
      isUsableCreatorStyleProfile({
        ...EMPTY,
        summary: "Punchy, direct, short paragraphs with a contrarian opener.",
        hook_patterns: [{ name: "Bold claim", description: "opens contrarian" }],
        formatting_rules: ["double line breaks"],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateCreatorStyleProfile: an empty/unusable tool result retries once
// (mirroring the existing truncated/no-args retry), then throws so
// runCreatorStyleGeneration's catch marks the row 'failed' rather than
// persisting a blank "ready" style.
// ---------------------------------------------------------------------------

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn(async () => {});

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...orig, completeChat, logOpenRouterUsage };
});

const { generateCreatorStyleProfile } = await import("@/lib/agent/creator-style-profile");

const USABLE_TOOL_ARGS = {
  summary: "Punchy, direct, short paragraphs with a contrarian opener.",
  voice_traits: ["blunt", "direct"],
};

function chatResult(toolArgs: Record<string, unknown> | null, finishReason = "tool_calls") {
  return { toolArgs, finishReason, usage: { prompt_tokens: 10, completion_tokens: 10 } };
}

beforeEach(() => {
  completeChat.mockReset();
  logOpenRouterUsage.mockClear();
});

describe("generateCreatorStyleProfile — semantic usability guard", () => {
  test("a usable result on the first attempt is returned, no retry", async () => {
    completeChat.mockResolvedValueOnce(chatResult(USABLE_TOOL_ARGS));
    const profile = await generateCreatorStyleProfile({ workspaceId: "ws1", posts: [] });
    expect(profile.summary).toBe(USABLE_TOOL_ARGS.summary);
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  test("REGRESSION: an empty {} tool result retries once, then throws instead of returning a blank profile", async () => {
    completeChat.mockResolvedValueOnce(chatResult({}));
    completeChat.mockResolvedValueOnce(chatResult({}));
    await expect(
      generateCreatorStyleProfile({ workspaceId: "ws1", posts: [] }),
    ).rejects.toThrow(/no usable result/i);
    expect(completeChat).toHaveBeenCalledTimes(2);
  });

  test("an empty {} result on attempt 1, usable on the retry → returns the usable profile", async () => {
    completeChat.mockResolvedValueOnce(chatResult({}));
    completeChat.mockResolvedValueOnce(chatResult(USABLE_TOOL_ARGS));
    const profile = await generateCreatorStyleProfile({ workspaceId: "ws1", posts: [] });
    expect(profile.summary).toBe(USABLE_TOOL_ARGS.summary);
    expect(completeChat).toHaveBeenCalledTimes(2);
  });

  test("a summary-only (no mechanics) result is treated as unusable and retried", async () => {
    completeChat.mockResolvedValueOnce(chatResult({ summary: "Punchy and direct." }));
    completeChat.mockResolvedValueOnce(chatResult(USABLE_TOOL_ARGS));
    const profile = await generateCreatorStyleProfile({ workspaceId: "ws1", posts: [] });
    expect(profile.voice_traits.length).toBeGreaterThan(0);
    expect(completeChat).toHaveBeenCalledTimes(2);
  });
});
