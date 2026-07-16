import { describe, expect, test } from "vitest";
import {
  classifyDirectRefineFocus,
  directRefineFocusSignals,
  hasMixedDirectRefineFocuses,
  hasUnrecognizedCompoundRefineClause,
  isExclusiveHookRefine,
  requestedShortenReduction,
  transformDirectRefineCandidate,
} from "@/lib/agent/direct-refine-policy";

const ORIGINAL = [
  "The safest career is the one people can see you building.",
  "",
  "A title is rented from a company.",
  "Your reputation is an asset you carry between companies.",
  "",
  "Share useful work before you need the opportunity.",
].join("\n");

describe("direct refine policy", () => {
  test.each([
    ["Tighten the hook", "hook"],
    ["Make the opening more contrarian", "hook"],
    ["Give this a stronger CTA", "cta"],
    ["Rewrite the closing line", "cta"],
    ["Make it shorter", "shorten"],
    ["Trim this by 20%", "shorten"],
    ["Make this more story-driven", "general"],
  ] as const)("classifies %s as %s", (instruction, focus) => {
    expect(classifyDirectRefineFocus(instruction)).toBe(focus);
  });

  test.each([
    ["Tighten the hook and strengthen the CTA", ["hook", "cta"]],
    ["Shorten it and strengthen the CTA", ["cta", "shorten"]],
    ["Shorten the entire post and tighten the hook", ["hook", "shorten"]],
    ["Make it more story-driven and tighten the hook", ["hook", "general"]],
  ] as const)("detects every focus in %s", (instruction, focuses) => {
    expect(directRefineFocusSignals(instruction)).toEqual(focuses);
    expect(hasMixedDirectRefineFocuses(instruction)).toBe(true);
  });

  test("only a single hook focus may use the trusted hook-only splice", () => {
    expect(isExclusiveHookRefine("Tighten the hook")).toBe(true);
    expect(
      isExclusiveHookRefine("Tighten the hook and strengthen the CTA"),
    ).toBe(false);
  });

  test("treats an exact final-line preservation constraint as non-actionable", () => {
    const instruction =
      "Make the hook punchier and keep the exact final line #SWIPEIN_QA_20260716.";

    expect(directRefineFocusSignals(instruction)).toEqual(["hook"]);
    expect(hasMixedDirectRefineFocuses(instruction)).toBe(false);
    expect(isExclusiveHookRefine(instruction)).toBe(true);
  });

  test("uses an explicit or light shortening target instead of always forcing 15%", () => {
    expect(requestedShortenReduction("Make it 10% shorter")).toBe(0.1);
    expect(requestedShortenReduction("Make it 10.5% shorter")).toBe(0.105);
    expect(requestedShortenReduction("Trim this by 20%")).toBe(0.2);
    expect(requestedShortenReduction("Cut the post down by 12.5%")).toBe(0.125);
    expect(requestedShortenReduction("Shorten it by 10 percent")).toBe(0.1);
    expect(requestedShortenReduction("Make it slightly shorter")).toBe(0.05);
    expect(requestedShortenReduction("Make it shorter")).toBe(0.15);
  });

  test("fails closed when a narrow edit hides an unrecognized compound edit", () => {
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook and add a personal anecdote",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Strengthen the CTA and make the body more skimmable",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook while adding a personal anecdote to the body",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook and weave in an anecdote",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Strengthen the CTA while making the body more skimmable",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook. Tell a quick personal story in the middle",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook, and don't forget to add a personal anecdote",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook and keep adding personal anecdotes to the body",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook and keep rewriting the middle",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook & add a personal anecdote",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook / rewrite the middle",
      ),
    ).toBe(true);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook and keep the rest unchanged",
      ),
    ).toBe(false);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook and do not change the rest",
      ),
    ).toBe(false);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Tighten the hook without changing the body",
      ),
    ).toBe(false);
    expect(
      hasUnrecognizedCompoundRefineClause(
        "Make it more direct and more story-driven",
      ),
    ).toBe(false);
    expect(
      isExclusiveHookRefine(
        "Tighten the hook and add a personal anecdote",
      ),
    ).toBe(false);
    expect(
      isExclusiveHookRefine(
        "Tighten the hook while adding a personal anecdote to the body",
      ),
    ).toBe(false);
  });

  test("a hook refine replaces only the opener", () => {
    const candidate = [
      "Your title is rented. Your reputation is owned.",
      "",
      "This model-generated body must never escape.",
      "",
      "Wrong ending.",
    ].join("\n");

    expect(
      transformDirectRefineCandidate({
        focus: "hook",
        originalBody: ORIGINAL,
        candidateBody: candidate,
      }),
    ).toEqual({
      ok: true,
      body: [
        "Your title is rented. Your reputation is owned.",
        "",
        "A title is rented from a company.",
        "Your reputation is an asset you carry between companies.",
        "",
        "Share useful work before you need the opportunity.",
      ].join("\n"),
    });
  });

  test("hook and CTA character limits apply to the changed segment, not the whole post", () => {
    expect(
      transformDirectRefineCandidate({
        focus: "hook",
        originalBody: ORIGINAL,
        candidateBody: "This opener is deliberately too long for the limit.",
        characterRange: { max: 20 },
      }),
    ).toMatchObject({ ok: false });
    expect(
      transformDirectRefineCandidate({
        focus: "cta",
        originalBody: ORIGINAL,
        candidateBody: "Build proof.",
        characterRange: { max: 20 },
      }),
    ).toEqual({
      ok: true,
      body: ORIGINAL.replace(
        "Share useful work before you need the opportunity.",
        "Build proof.",
      ),
    });
  });

  test("a CTA refine preserves every byte before the final paragraph", () => {
    const candidate = `${ORIGINAL.replace(
      "A title is rented from a company.",
      "This unwanted rewrite must be discarded.",
    )}\n\nPublish proof before you need permission.`;
    const result = transformDirectRefineCandidate({
      focus: "cta",
      originalBody: ORIGINAL,
      candidateBody: candidate,
    });

    expect(result).toEqual({
      ok: true,
      body: ORIGINAL.replace(
        "Share useful work before you need the opportunity.",
        "Publish proof before you need permission.",
      ),
    });
  });

  test("a shorten refine must materially shorten without collapsing", () => {
    const longOriginal = `${ORIGINAL}\n\n${"Useful context stays grounded. ".repeat(20)}`;
    expect(
      transformDirectRefineCandidate({
        focus: "shorten",
        originalBody: longOriginal,
        candidateBody: longOriginal,
      }),
    ).toMatchObject({ ok: false });
    expect(
      transformDirectRefineCandidate({
        focus: "shorten",
        originalBody: longOriginal,
        candidateBody: "A lone hook.",
      }),
    ).toMatchObject({ ok: false });

    const shorter = longOriginal.slice(0, Math.floor(longOriginal.length * 0.8));
    expect(
      transformDirectRefineCandidate({
        focus: "shorten",
        originalBody: longOriginal,
        candidateBody: shorter,
      }),
    ).toEqual({ ok: true, body: shorter });
  });

  test("accepts a complete 10% trim that the generic 15% floor would reject", () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, index) => `Proof paragraph ${index + 1} keeps the argument complete.`,
    );
    const originalBody = `${ORIGINAL}\n\n${paragraphs.join("\n\n")}`;
    const candidateBody = `${ORIGINAL}\n\n${paragraphs.slice(0, 10).join("\n\n")}`;
    const ratio = candidateBody.length / originalBody.length;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThanOrEqual(0.9);

    expect(
      transformDirectRefineCandidate({
        focus: "shorten",
        instruction: "Make it 10% shorter.",
        originalBody,
        candidateBody,
      }),
    ).toEqual({ ok: true, body: candidateBody });
  });

  test("a general rewrite rejects a collapsed fragment", () => {
    const longOriginal = `${ORIGINAL}\n\n${"Useful context stays grounded. ".repeat(20)}`;
    expect(
      transformDirectRefineCandidate({
        focus: "general",
        originalBody: longOriginal,
        candidateBody: "A lone hook.",
      }),
    ).toMatchObject({ ok: false });
  });

  test("rejects a no-op revision so bounded repair can apply the request", () => {
    expect(
      transformDirectRefineCandidate({
        focus: "general",
        originalBody: ORIGINAL,
        candidateBody: ORIGINAL,
      }),
    ).toMatchObject({ ok: false });
    expect(
      transformDirectRefineCandidate({
        focus: "hook",
        originalBody: ORIGINAL,
        candidateBody: ORIGINAL,
      }),
    ).toMatchObject({ ok: false });
  });
});
