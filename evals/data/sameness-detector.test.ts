import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  checkSameness,
  buildSamenessUserContent,
  isAcceptableRewrite,
  parseSamenessArgs,
  samenessEnabled,
  SAMENESS_MIN_PRIOR_DRAFTS,
} from "@/lib/agent/specialists/sameness";
import { truncateForPrompt } from "@/lib/recent-drafts";
import type { RecentDraft } from "@/lib/recent-drafts";

// The pure logic behind the sameness detector. The model-driven pass itself is
// covered by fail-open path tests (no priorDrafts → pass-through, disabled →
// pass-through) — the actual Sonnet call is out of scope for unit tests and
// gets integration coverage via the eval suite later.

describe("truncateForPrompt", () => {
  test("short body passes through unchanged", () => {
    const body = "Hey. Short post about hooks.";
    expect(truncateForPrompt(body, 400)).toBe(body);
  });

  test("truncates at a paragraph break when one is inside the last 40%", () => {
    const body =
      "First paragraph here with some content that fills space.\n\nSecond paragraph continues the argument.\n\nThird paragraph is beyond the cap so should be cut.";
    const out = truncateForPrompt(body, 120);
    expect(out.length).toBeLessThanOrEqual(120 + 1); // …
    expect(out.endsWith("…")).toBe(true);
    // Cuts at a paragraph boundary, not mid-word.
    expect(out).not.toMatch(/[A-Za-z]…$/);
  });

  test("falls back to a sentence end when no paragraph break is near the cap", () => {
    const body =
      "Sentence one is a full thought. Sentence two continues the reasoning. Sentence three pushes past the cap for testing.";
    const out = truncateForPrompt(body, 80);
    expect(out.length).toBeLessThanOrEqual(85);
    // Sentence end: closes after a period.
    expect(out).toMatch(/\.\s?…?$/);
  });

  test("falls back to a word boundary when no sentence end is near the cap", () => {
    const body = "one two three four five six seven eight nine ten eleven twelve";
    const out = truncateForPrompt(body, 30);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out.endsWith("…")).toBe(true);
    // Cut at a word boundary → the char before "…" is a complete word, and no
    // word is sliced in half (the source has no partial words at the cut).
    expect(out).toBe("one two three four five six…");
  });
});

describe("parseSamenessArgs", () => {
  test("well-formed args parse to structured verdict", () => {
    const args = {
      overlap_markers: ["League of Legends", "Portugal", "hooks framing"],
      rewrote: true,
      rewritten_body: "Rewritten post body here.",
      reason: "Three biographical anchors reused; rewrote for a fresh angle.",
    };
    expect(parseSamenessArgs(args)).toEqual({
      overlapMarkers: ["League of Legends", "Portugal", "hooks framing"],
      rewrote: true,
      rewrittenBody: "Rewritten post body here.",
      reason: "Three biographical anchors reused; rewrote for a fresh angle.",
    });
  });

  test("null / undefined / wrong shape → safe defaults", () => {
    expect(parseSamenessArgs(null)).toEqual({
      overlapMarkers: [],
      rewrote: false,
      rewrittenBody: "",
      reason: "",
    });
    expect(parseSamenessArgs(undefined)).toEqual({
      overlapMarkers: [],
      rewrote: false,
      rewrittenBody: "",
      reason: "",
    });
    expect(parseSamenessArgs("not an object")).toEqual({
      overlapMarkers: [],
      rewrote: false,
      rewrittenBody: "",
      reason: "",
    });
  });

  test("filters non-string entries out of overlap_markers", () => {
    const args = {
      overlap_markers: ["real marker", 42, null, "another marker"],
      rewrote: false,
      rewritten_body: "",
      reason: "",
    };
    expect(parseSamenessArgs(args).overlapMarkers).toEqual([
      "real marker",
      "another marker",
    ]);
  });

  test("rewrote must be strictly true (no coercion)", () => {
    expect(
      parseSamenessArgs({
        overlap_markers: [],
        rewrote: "true",
        rewritten_body: "",
        reason: "",
      }).rewrote,
    ).toBe(false);
    expect(
      parseSamenessArgs({
        overlap_markers: [],
        rewrote: 1,
        rewritten_body: "",
        reason: "",
      }).rewrote,
    ).toBe(false);
  });
});

describe("isAcceptableRewrite", () => {
  const input =
    "This is a fairly typical LinkedIn post body — long enough to test the length guards on a rewrite. It talks about content, hooks, and shipping.";

  test("empty rewrite → rejected", () => {
    expect(isAcceptableRewrite(input, "")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(isAcceptableRewrite(input, "   ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  test("drastically shorter rewrite (<60% length) → rejected", () => {
    const tiny = "Too short.";
    expect(isAcceptableRewrite(input, tiny)).toEqual({
      ok: false,
      reason: "too_short",
    });
  });

  test("rewrite that leaks tool-call XML → rejected as corrupted", () => {
    const corrupted =
      "Solid rewrite here that explains the content approach with enough detail to pass length but also <tool_call>get_voice</tool_call> leaked in.";
    const res = isAcceptableRewrite(input, corrupted);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/^corrupted:/);
  });

  test("healthy rewrite of similar length → accepted", () => {
    const rewrite =
      "This is a fresh take on the same idea but written from a different angle. Similar length, same voice, no biographical crutch.";
    expect(isAcceptableRewrite(input, rewrite)).toEqual({ ok: true });
  });

  test("rewrite exceeding maxChars → rejected as too_long", () => {
    const rewrite =
      "This is a fresh take on the same idea but written from a different angle. Similar length, same voice, no biographical crutch.";
    expect(isAcceptableRewrite(input, rewrite, 50)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  test("rewrite within maxChars → accepted", () => {
    const rewrite =
      "This is a fresh take on the same idea but written from a different angle. Similar length, same voice, no biographical crutch.";
    expect(isAcceptableRewrite(input, rewrite, 3200)).toEqual({ ok: true });
  });

  test("no maxChars supplied → no upper bound enforced", () => {
    const rewrite = "x".repeat(5000);
    const longInput = "y".repeat(5000);
    expect(isAcceptableRewrite(longInput, rewrite)).toEqual({ ok: true });
  });
});

describe("buildSamenessUserContent — batch prompt caching", () => {
  const priorDrafts: RecentDraft[] = [
    { id: "d1", body: "Prior one.", createdAt: "2026-01-01" },
    { id: "d2", body: "Prior two.", createdAt: "2026-01-02" },
  ];

  test("keeps the prior-draft prefix cacheable and the new draft uncached", () => {
    const blocks = buildSamenessUserContent("Brand new draft.", priorDrafts);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[1]).toEqual({
      type: "text",
      text: "\n\nNEW DRAFT to check:\n\nBrand new draft.",
    });
  });

  test("the cacheable prefix is identical across drafts in one batch", () => {
    const first = buildSamenessUserContent("First new draft.", priorDrafts);
    const second = buildSamenessUserContent("Second new draft.", priorDrafts);
    expect(first[0]).toEqual(second[0]);
    expect(first[1]).not.toEqual(second[1]);
  });

  test("concatenated blocks preserve the previous prompt text exactly", () => {
    const blocks = buildSamenessUserContent("Brand new draft.", priorDrafts);
    const text = blocks.map((block) => block.type === "text" ? block.text : "").join("");
    expect(text).toBe(
      "PRIOR DRAFTS (most recent first):\n\n" +
        "[Prior draft 1]\nPrior one.\n\n---\n\n" +
        "[Prior draft 2]\nPrior two.\n\n---\n\n" +
        "NEW DRAFT to check:\n\nBrand new draft.",
    );
  });
});

describe("checkSameness — fail-open + skip paths (no model call reached)", () => {
  beforeEach(() => {
    delete process.env.AGENT_SAMENESS_CHECK;
  });
  afterEach(() => {
    delete process.env.AGENT_SAMENESS_CHECK;
  });

  test("returns pass-through when disabled via env flag", async () => {
    process.env.AGENT_SAMENESS_CHECK = "0";
    expect(samenessEnabled()).toBe(false);
    const priorDrafts: RecentDraft[] = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`,
      body: "Long enough prior draft body to matter.",
      createdAt: "2026-01-01",
    }));
    const result = await checkSameness({
      body: "A new draft body.",
      priorDrafts,
    });
    expect(result).toEqual({
      body: "A new draft body.",
      rewrote: false,
      overlapMarkers: [],
      reason: "",
    });
  });

  test("returns pass-through when priorDrafts is under the minimum", async () => {
    const priorDrafts: RecentDraft[] = Array.from(
      { length: SAMENESS_MIN_PRIOR_DRAFTS - 1 },
      (_, i) => ({
        id: `d${i}`,
        body: "Prior draft.",
        createdAt: "2026-01-01",
      }),
    );
    const result = await checkSameness({
      body: "A new draft body.",
      priorDrafts,
    });
    expect(result.rewrote).toBe(false);
    expect(result.body).toBe("A new draft body.");
    expect(result.overlapMarkers).toEqual([]);
  });

  test("returns pass-through on empty input body (no model call)", async () => {
    const priorDrafts: RecentDraft[] = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`,
      body: "Prior draft.",
      createdAt: "2026-01-01",
    }));
    const result = await checkSameness({ body: "   ", priorDrafts });
    expect(result.rewrote).toBe(false);
    expect(result.body).toBe("   ");
  });
});
