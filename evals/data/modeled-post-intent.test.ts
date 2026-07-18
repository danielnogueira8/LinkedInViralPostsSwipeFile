import { describe, expect, test } from "vitest";
import {
  compileModeledPostIntent,
  MAX_MODELED_POST_INTENT_CHARS,
} from "@/lib/agent/modeled-post-intent";

describe("modeled post intent compiler", () => {
  test.each([
    [
      "Find 4 top posts in my swipe file and rewrite them into 3 original posts.",
      { relation: "shared_pool", expectedDrafts: 3, minimumSources: 4 },
    ],
    [
      "Write 4 original posts modeled after 2 top-performing regular posts you find in my swipe file.",
      { relation: "shared_pool", expectedDrafts: 4, minimumSources: 2 },
    ],
    [
      "Write 4 original posts modeled on three sources you find in my swipe file.",
      { relation: "shared_pool", expectedDrafts: 4, minimumSources: 3 },
    ],
    [
      "Find top-performing regular posts in my swipe file and write 3 original posts modeled after them.",
      { relation: "one_to_one", expectedDrafts: 3, minimumSources: 3 },
    ],
    [
      "Pull 4 top posts from my swipe file and model 4 new posts after them.",
      { relation: "one_to_one", expectedDrafts: 4, minimumSources: 4 },
    ],
    [
      "Find 4 top-performing regular posts in my swipe file, choose the best, and rewrite it in my voice.",
      { relation: "one_to_one", expectedDrafts: 1, minimumSources: 4 },
    ],
    [
      "Find 4 top-performing regular posts in my swipe file, choose the best 2, and rewrite them in my voice.",
      { relation: "one_to_one", expectedDrafts: 2, minimumSources: 4 },
    ],
    [
      "Find 4 top-performing regular posts in my swipe file and make one new post from each.",
      { relation: "one_to_one", expectedDrafts: 4, minimumSources: 4 },
    ],
    [
      "Find 4 top-performing regular posts in my swipe file and produce one original post per source.",
      { relation: "one_to_one", expectedDrafts: 4, minimumSources: 4 },
    ],
  ] as const)("compiles one explicit source-selection-output contract: %s", (text, expected) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      ...expected,
    });
  });

  test.each([
    "Find 4 top posts and turn each into a new post.",
    "Show me 4 top posts and turn each into a new post.",
    "Find 4 top posts and turn every one into a new post.",
    "Find 4 top posts and create a post for every source.",
    "Find 4 top posts and write one post apiece.",
    "Select the top 4 posts to model one post from each.",
    "Find 4 posts and for each source write one post modeled after it.",
    "Find 4 posts. For each, write one post modeled after it.",
    "Find 4 posts and write 4 posts, one for each source.",
  ])("maps natural distributive syntax one-to-one: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 4,
      minimumSources: 4,
    });
  });

  test.each([
    "Find 5 top posts, select 3, and rewrite each.",
    "Find 5 top posts, choose 3. Then rewrite each one.",
    "Find 5 top posts, choose 3 of the 5, and rewrite each one.",
  ])("binds a punctuated selection count without absorbing its denominator: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 3,
      minimumSources: 5,
    });
  });

  test.each([
    "Find 4 regular posts, choose based on 3 criteria, and rewrite them.",
    "Find 4 posts from the last 7 days, choose the best based on engagement over 7 days, and rewrite it.",
    "Find 4 posts, choose the best over 7 days, and rewrite it.",
  ])("does not absorb topical or temporal numbers into selection: %s", (text) => {
    const intent = compileModeledPostIntent(text);
    if (text.includes("choose the best")) {
      expect(intent).toMatchObject({
        kind: "exact",
        expectedDrafts: 1,
        minimumSources: 4,
      });
    } else {
      expect(intent).toMatchObject({
        kind: "exact",
        expectedDrafts: 4,
        minimumSources: 4,
      });
    }
  });

  test.each([
    "Find 4 top posts and rewrite one of them.",
    "Find 4 top posts and rewrite the best one.",
    "Find 4 top posts and adapt only one.",
  ])("treats an inline singular target as narrowing: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 1,
      minimumSources: 4,
    });
  });

  test.each([
    "Find 4 top posts and rewrite 2 of them.",
    "Find 4 top posts and turn 2 of them into original posts.",
  ])("treats an inline plural subset as narrowing: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 2,
      minimumSources: 4,
    });
  });

  test.each([
    "Using 4 top posts you find in my swipe file, write one new post per source.",
    "Write 4 posts, each using one top post you find in my swipe file.",
    "Create one new post from each of 4 top posts you find in my swipe file.",
    "Write 4 original posts using 4 top posts you find in my swipe file.",
    "Create 4 original posts from 4 top posts you find in my swipe file.",
  ])("binds output-first source relations: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 4,
      minimumSources: 4,
    });
  });

  test.each([
    "Find: 4 top posts. Rewrite each one.",
    "Find the following: 4 top posts. Rewrite each one.",
    "Find:\n4 top-performing posts.\nRewrite each one.",
  ])("retains a command role across formatting punctuation: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      expectedDrafts: 4,
      minimumSources: 4,
    });
  });

  test.each([
    "Discover 4 top posts and rewrite each one.",
    "Locate 4 top posts and rewrite each one.",
    "Retrieve 4 top posts and rewrite each one.",
    "Surface 4 top posts and rewrite each one.",
    "Analyze 4 top posts and rewrite each one.",
  ])("normalizes equivalent source commands: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      expectedDrafts: 4,
      minimumSources: 4,
    });
  });

  test.each([
    "Find a top post in my swipe file and replicate its format.",
    "Find a top post in my swipe file and model its structure.",
    "Find a top post in my swipe file and rewrite this in my voice.",
    "Find a top post in my swipe file and adapt the structure.",
    "Find a top post in my swipe file and mimic its hook style.",
  ])("recognizes an explicit singular structure target: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      expectedDrafts: 1,
      minimumSources: 1,
    });
  });

  test.each([
    "Review 4 top posts and create 4 posts based on their formats.",
    "Review 4 top posts and write 4 posts inspired by them.",
    "Review 4 top posts and create 4 posts following their structures.",
    "Review 4 top posts and write 4 posts in their style.",
  ])("compiles explicit structural modeling relations: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 4,
      minimumSources: 4,
    });
  });

  test.each([
    "Find 5 top posts, choose any 3, and rewrite them.",
    "Find 5 top posts, choose the most relevant 3, and rewrite them.",
    "Find 5 top posts, select the best-performing 3, and rewrite them.",
    "Find 5 top posts, narrow to 3, and rewrite them.",
    "Find 5 top posts, keep 3, and rewrite them.",
  ])("binds a natural selection modifier to its exact subset: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 3,
      minimumSources: 5,
    });
  });

  test.each([
    "Find 4 top posts and rewrite them with a proven post structure.",
    "Find 4 top posts and rewrite them in a LinkedIn post format.",
    "Find 4 top posts and rewrite them with a post framework that fits my voice.",
    "Find 4 top posts and rewrite them following a post template.",
  ])("does not let a singular format constraint replace the batch count: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 4,
      minimumSources: 4,
    });
  });

  test.each([
    "Write 3 posts inspired by 5 top sources you find in my swipe file.",
    "Write 3 posts by modeling 5 top posts you find in my swipe file.",
  ])("retains an output-first source-pool count: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "shared_pool",
      expectedDrafts: 3,
      minimumSources: 5,
    });
  });

  test.each([
    "Find 4 top posts and write 3 posts modeled after them, each with a different hook.",
    "Find 4 top posts and write one post modeled after them that includes each of 3 themes.",
  ])("does not treat topical each as a source-to-draft multiplier: %s", (text) => {
    const expectedDrafts = text.includes("write one post") ? 1 : 3;
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "shared_pool",
      expectedDrafts,
      minimumSources: 4,
    });
  });

  test.each([
    "Find 2 top posts and make 2 versions of each.",
    "Find 2 top posts and create 2 posts apiece.",
    "Find 4 top posts, select 2, and rewrite each into 2 variations.",
    "Find 2 posts from each of 2 creators and rewrite every post.",
  ])("fails closed on unsupported multiplicative mappings: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "ambiguous",
      reason: "mapping",
    });
  });

  test.each([
    "Find 4 top posts and rewrite a few of them.",
    "Find 4 top posts and rewrite most of them.",
    "Find 4 top posts and create several modeled versions.",
  ])("fails closed on an unspecified subset or output count: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({ kind: "ambiguous" });
  });

  test.each([
    "Find 4 top posts and rewrite them for creators averaging 2 posts per week.",
    "Find 4 top posts and rewrite them about 3 mistakes in content marketing.",
  ])("does not replace the source mapping with a topical cardinality: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 4,
      minimumSources: 4,
    });
  });

  test.each([
    "Find 4 or 5 top-performing regular posts in my swipe file and rewrite them.",
    "Find between 4 and 5 top-performing regular posts in my swipe file and rewrite them.",
    "Find my #4 top-performing regular post in my swipe file and rewrite it.",
    "Find post #4 in my swipe file and rewrite it.",
    "Find the 4th top-performing regular post in my swipe file and rewrite it.",
    "Find -4 top-performing regular posts in my swipe file and rewrite them.",
    "Find 4.5 top-performing regular posts in my swipe file and rewrite them.",
    "Find 1,000 top-performing regular posts in my swipe file and rewrite them.",
    "Find at least 4 top-performing regular posts in my swipe file and rewrite them.",
    "Find up to 4 top-performing regular posts in my swipe file and rewrite them.",
    "Find more than 4 top-performing regular posts in my swipe file and rewrite them.",
    "Find 3 top-performing regular posts with 5 examples each and rewrite them.",
    "Find 4 top posts and rewrite them into 3 original posts plus 2 variations.",
    "Find 4/5 top-performing posts and rewrite them.",
    "Find four/five top-performing posts and rewrite them.",
    "Find four-five top-performing posts and rewrite them.",
    "Find 4 & 5 top-performing posts and rewrite them.",
    "Find 4, 5 top-performing posts and rewrite them.",
    "Find 4−5 top-performing posts and rewrite them.",
    "Find minus four top-performing posts and rewrite them.",
    "Find negative 4 top-performing posts and rewrite them.",
    "Find 4 top posts and rewrite them into 0 posts.",
    "Find 4 top posts and write zero posts modeled after them.",
    "Find 4 top posts and write 11 posts modeled after them.",
    "Find 4 top posts and rewrite them into eleven posts.",
    "Find 4 top posts, choose zero, and rewrite them.",
    "Find 6 top posts and rewrite each one.",
    "Find 2 regular posts and 2 lead magnet posts, then create 4 posts modeled after them.",
    "Find 4 top posts and create 2 regular posts and 2 lead magnet posts modeled after them.",
    "Find 2 top posts and write 2 original posts plus 2 variations modeled after them.",
  ])("fails closed on a non-exact or conflicting cardinality: %s", (text) => {
    expect(compileModeledPostIntent(text)).toMatchObject({ kind: "ambiguous" });
  });

  test.each([
    "Find 4 top posts in my swipe file, but don't rewrite them; just compare them.",
    "Find 4 top posts in my swipe file. Do not adapt them. Give me the findings.",
    "Find top posts about rewriting hooks and summarize the trends.",
    "Find 4 top posts about how to rewrite them and summarize the trends.",
    "Find 4 top posts about why founders rewrite each post and summarize them.",
    "Find 4 top posts with the title Rewrite each post and summarize them.",
    "Find 4 top posts and avoid rewriting them; compare them.",
    "Find 4 top posts and skip rewriting them; compare them.",
    "Find 4 top posts and refrain from rewriting them; compare them.",
    "Find 4 top posts and rewrite none; compare them.",
    "Find 4 top posts and rather than rewrite them, compare them.",
    "Find 4 top posts and instead of rewriting them, compare them.",
    "Do not use any of the top posts you find to rewrite anything; compare them.",
    "Find 3 top posts and turn them into a comparison table.",
    "Find 3 top posts and turn each one into a slide.",
  ])("does not execute a negated or topical transformation word: %s", (text) => {
    expect(compileModeledPostIntent(text)).toEqual({ kind: "none" });
  });

  test("treats quoted post instructions as source data", () => {
    for (const text of [
      'Find a top post with the hook "Write 5 posts that convert" in my swipe file and rewrite it in my voice.',
      "Find a top post with the hook 'Write 5 posts that convert' in my swipe file and rewrite it in my voice.",
      "Find a top post with the hook ‘Write 5 posts that convert’ in my swipe file and rewrite it in my voice.",
      "Find a top post with the hook `Write 5 posts that convert` in my swipe file and rewrite it in my voice.",
    ]) {
      expect(compileModeledPostIntent(text)).toMatchObject({
        kind: "exact",
        expectedDrafts: 1,
        minimumSources: 1,
      });
    }
  });

  test("keeps an exact larger discovery pool for a supported selected subset", () => {
    expect(
      compileModeledPostIntent(
        "Find 10 top posts, choose 2 posts, and rewrite them.",
      ),
    ).toMatchObject({
      kind: "exact",
      relation: "one_to_one",
      expectedDrafts: 2,
      minimumSources: 10,
    });
  });

  test.each([
    "Find several top posts, choose the best, and rewrite it.",
    "Find multiple top posts, choose the best, and rewrite it.",
    "Find a few top posts, choose the best, and rewrite it.",
    "Find a handful of top posts, choose the best, and rewrite it.",
  ])("never collapses a plural comparison pool to one fetched source: %s", (text) => {
    const intent = compileModeledPostIntent(text);
    expect(intent).toMatchObject({ kind: "exact", expectedDrafts: 1 });
    expect(intent.kind === "exact" && intent.minimumSources).toBeGreaterThan(1);
  });

  test("does not treat topical list cardinality as a post count", () => {
    expect(
      compileModeledPostIntent(
        "Find a top post in my swipe file and rewrite it about 3 mistakes in content marketing.",
      ),
    ).toMatchObject({
      kind: "exact",
      expectedDrafts: 1,
      minimumSources: 1,
    });
  });

  test("treats an explicit modeling opt-out as an original-writing request", () => {
    expect(
      compileModeledPostIntent(
        "Write an original post without modeling a source.",
      ),
    ).toEqual({ kind: "none" });
  });

  test("rejects modeled input one character over the hard resource bound", () => {
    expect(
      compileModeledPostIntent(
        `Find top posts in my swipe file and rewrite them. ${"1 ".repeat(MAX_MODELED_POST_INTENT_CHARS)}`,
      ),
    ).toMatchObject({ kind: "ambiguous", reason: "invalid_quantity" });
  });

  test("scans an adversarial token stream exactly at the hard resource bound", () => {
    const text = "1 ".repeat(MAX_MODELED_POST_INTENT_CHARS / 2);
    expect(text).toHaveLength(MAX_MODELED_POST_INTENT_CHARS);
    expect(compileModeledPostIntent(text)).toEqual({ kind: "none" });
  });
});
