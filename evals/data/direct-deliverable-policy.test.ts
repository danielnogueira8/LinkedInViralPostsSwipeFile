import { describe, expect, test } from "vitest";
import {
  compileDirectPartialTextSpec,
  requestedDirectPostCount,
} from "@/lib/agent/direct-deliverable-policy";
import { POST_INTENTS } from "@/lib/post-intents";

describe("direct deliverable compiler", () => {
  test.each([
    ["Give me exactly 3 hooks about distribution. Do not search.", "Hook", 3],
    ["Draft 5 post ideas about pricing. No browsing.", "Idea", 5],
    [
      "Write an opening line about career leverage. Do not search.",
      "Opener",
      1,
    ],
  ])("compiles %s", (instruction, label, expectedCount) => {
    expect(compileDirectPartialTextSpec(instruction)).toMatchObject({
      label,
      expectedCount,
      contract: {
        expectedCount,
        requiredFields: [label],
        forbidFraming: true,
      },
    });
  });

  test("preserves explicit field labels", () => {
    expect(
      compileDirectPartialTextSpec(
        "Give me exactly 3 hooks. Include only: Hook and Rationale. No search.",
      ),
    ).toMatchObject({
      contract: {
        expectedCount: 3,
        requiredFields: ["Hook", "Rationale"],
        fieldsOnly: true,
      },
    });
  });

  test("preserves natural per-item labels instead of silently dropping them", () => {
    expect(
      compileDirectPartialTextSpec(
        "Give me 3 hooks about pricing with a Hook and Why it works label for each. Do not search.",
      ),
    ).toMatchObject({
      expectedCount: 3,
      contract: {
        requiredFields: ["Hook", "Why it works"],
      },
    });
  });

  test.each([
    [
      "Give me 3 hooks about pricing, each with:\nHook:\nWhy it works:\nDo not search.",
      ["Hook", "Why it works"],
    ],
    [
      "Give me 3 hooks about pricing, each labeled with Hook and Rationale. Do not search.",
      ["Hook", "Rationale"],
    ],
    [
      "Give me 3 hooks about pricing. Add a rationale beneath each. Do not search.",
      ["Hook", "rationale"],
    ],
    [
      "Give me 3 hooks about pricing. Include a reason for each. Do not search.",
      ["Hook", "reason"],
    ],
    [
      "Give me 3 hooks about pricing, with the rationale beneath each. Do not search.",
      ["Hook", "rationale"],
    ],
    [
      "Give me 3 hooks about pricing. For each, use Hook and Rationale labels. Do not search.",
      ["Hook", "Rationale"],
    ],
    [
      "Give me 3 hooks about pricing, each with Hook: and Why it works:. Do not search.",
      ["Hook", "Why it works"],
    ],
    [
      "Give me 3 hooks about pricing. For each hook, include a rationale. Do not search.",
      ["Hook", "rationale"],
    ],
    [
      "Give me 3 hooks about pricing. Each must have Hook and Rationale labels. Do not search.",
      ["Hook", "Rationale"],
    ],
    [
      "Give me 3 hooks about pricing. Every hook needs Hook and Rationale labels. Do not search.",
      ["Hook", "Rationale"],
    ],
    [
      "Give me 3 hooks about pricing. Each should include a Rationale field. Do not search.",
      ["Hook", "Rationale"],
    ],
    [
      "Give me 3 hooks about pricing. Put a Why it works label on every hook. Do not search.",
      ["Hook", "Why it works"],
    ],
    [
      "Give me 3 hooks about pricing with Hook and Rationale labels for each. Also include a Source field on every hook. Do not search.",
      ["Hook", "Rationale", "Source"],
    ],
    [
      "Give me 3 hooks about pricing. Each must have Hook and Rationale labels plus an Evidence field. Do not search.",
      ["Hook", "Rationale", "Evidence"],
    ],
    [
      "Give me 3 hooks about pricing. For each, use Hook and Rationale labels and also a Source field. Do not search.",
      ["Hook", "Rationale", "Source"],
    ],
  ])("compiles alternate per-item field syntax: %s", (instruction, fields) => {
    expect(
      compileDirectPartialTextSpec(instruction)?.contract.requiredFields,
    ).toEqual(fields);
  });

  test.each([
    "Give me 25 hooks about pricing. Do not search.",
    "Give me 0 hooks about pricing. Do not search.",
    "Give me several hooks about pricing. Do not search.",
    "Give me hooks about pricing. Do not search.",
    "Explain why hooks matter for pricing. Do not search.",
    "Give me 3 hooks. Include only: Rationale. No search.",
    "Give me 3 hooks about pricing, each under 80 characters. Do not search.",
    "Give me 3 hooks about pricing. Maximum 10 words each. Do not search.",
    "Give me 3 hooks about pricing, each exactly one sentence. Do not search.",
  ])("fails an unsafe or incomplete partial contract closed: %s", (instruction) => {
    expect(compileDirectPartialTextSpec(instruction)).toBeNull();
  });

  test("binds the count to the requested noun instead of a later sentence count", () => {
    expect(
      compileDirectPartialTextSpec(
        "Give me 3 hooks about pricing; make each exactly 2 sentences. Do not search.",
      ),
    ).toBeNull();
    expect(
      compileDirectPartialTextSpec(
        "Write a hook about exactly 5 pricing mistakes. Do not search.",
      )?.expectedCount,
    ).toBe(1);
  });

  test("bounds complex partials to contracts that fit the writer and full QA envelope", () => {
    expect(
      compileDirectPartialTextSpec(
        "Give me 20 hooks about pricing. Do not search.",
      )?.expectedCount,
    ).toBe(20);
    expect(
      compileDirectPartialTextSpec(
        "Give me 6 outlines about pricing. Do not search.",
      )?.expectedCount,
    ).toBe(6);
    expect(
      compileDirectPartialTextSpec(
        "Give me 7 outlines about pricing. Do not search.",
      ),
    ).toBeNull();
    expect(
      compileDirectPartialTextSpec(
        "Give me 5 outlines about pricing with an Outline and Goal and Beat and Evidence and CTA label for each. Do not search.",
      ),
    ).toBeNull();
  });

  test("rejects mixed partial kinds", () => {
    expect(
      compileDirectPartialTextSpec(
        "Give me 3 hooks and 3 titles. Do not search.",
      ),
    ).toBeNull();
  });

  test.each([
    ["Write exactly two complete post variations.", 2],
    ["Give me 3 variations of the attached post.", 3],
    ["Draft four distinct LinkedIn posts about pricing.", 4],
    ["Write seven posts about pricing.", 7],
    ["Write eleven posts about pricing.", null],
    ["Write several posts about pricing.", null],
  ])("compiles full-post count for %s", (instruction, expected) => {
    expect(requestedDirectPostCount(instruction)).toBe(expected);
  });

  test("compiles the production attached-source variations prompt", () => {
    expect(requestedDirectPostCount(POST_INTENTS.variations.prompt)).toBe(3);
  });

  test.each([
    "Give me 3 versions of the opening line.",
    "Give me 3 versions of the CTA.",
    "Give me 3 variations of the ending.",
    "Give me 3 rewrites of the first paragraph.",
    "Give me 3 versions of the headline.",
    "Give me 3 variations of the first sentence.",
  ])("does not compile a post-component count as full posts: %s", (instruction) => {
    expect(requestedDirectPostCount(instruction)).toBeNull();
  });

  // Regression: "model 3 regular posts" said it fetched/rewrote all 3 but
  // only rendered 1 — the modeling-verb family (model/mimic/adapt/rewrite/
  // rework/remix) and the "regular" adjective were both missing from this
  // count-extraction regex, so no count was ever detected for the phrasing.
  test.each([
    ["Model 3 regular posts.", 3],
    ["Mimic 2 posts.", 2],
    ["Adapt 4 posts for me.", 4],
    ["Rework three distinct posts.", 3],
  ])("compiles full-post count for the modeling-verb family: %s", (instruction, expected) => {
    expect(requestedDirectPostCount(instruction)).toBe(expected);
  });
});
