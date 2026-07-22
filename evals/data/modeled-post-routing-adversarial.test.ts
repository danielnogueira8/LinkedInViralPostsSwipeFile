import { describe, expect, test } from "vitest";
import { compileReadOnlyOrchestratorRoute } from "@/lib/agent/turn/compile";

const base = {
  isRefine: false,
  hasModelSource: false,
  hasAttachments: false,
  hasLeadMagnet: false,
  hasCreatorStyle: false,
};

function route(userInstruction: string) {
  return compileReadOnlyOrchestratorRoute({ ...base, userInstruction });
}

describe("modeled-post routing adversaries", () => {
  test.each([
    "Find 4 top posts without writing posts in their format. Give me the findings.",
    "Find 4 top posts about writing style and summarize them.",
    "Find 4 top posts whose title is Writing Style and summarize them.",
    "Find 4 inspiring posts and summarize the takeaways.",
    "Find 4 top posts inspired by a recent launch and summarize them.",
    "Find 4 top posts that follow this structure and summarize them.",
  ])("never turns source data or a negated command into drafts: %s", (text) => {
    expect(route(text)).toBeNull();
  });

  test.each([
    "Write 3 original posts on viral content",
    "Write 4 posts on top-performing content",
    "Create 2 posts on source selection",
    "Write 3 posts using examples from my experience",
    "Create 3 posts teaching people to find examples and follow their own style",
  ])("keeps original-writing topics on the direct writer: %s", (text) => {
    expect(route(text)).toBeNull();
  });

  test.each([
    "Find 2 top posts and make 2 versions of each.",
    "Find 4 top posts, select 2, and rewrite each into 2 variations.",
    "Find 2 posts from each of 2 creators and rewrite every post.",
  ])("clarifies unsupported multiplicative source mappings: %s", (text) => {
    expect(route(text)).toMatchObject({
      kind: "ambiguous_read_only",
      clarificationReason: "modeled_mapping",
      modeledAmbiguityReason: "mapping",
    });
  });

  test.each([
    "Find 5 top posts, choose any 3, and rewrite them.",
    "Find 5 top posts, choose the most relevant 3, and rewrite them.",
    "Find 5 top posts, select the best-performing 3, and rewrite them.",
    "Find 5 top posts, narrow to 3, and rewrite them.",
  ])("routes an exact selected subset one-to-one: %s", (text) => {
    expect(route(text)).toMatchObject({
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts: 3 },
      minimumSources: 5,
      workspaceDraftSourceMode: "one_to_one",
    });
  });

  test.each([
    "Find 4 top posts and rewrite them with a proven post structure.",
    "Find 4 top posts and rewrite them in a LinkedIn post format.",
    "Find 4 top posts and rewrite them following a post template.",
  ])("preserves the source count through format constraints: %s", (text) => {
    expect(route(text)).toMatchObject({
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts: 4 },
      minimumSources: 4,
      workspaceDraftSourceMode: "one_to_one",
    });
  });

  test.each([
    "Find at most 4 top posts and rewrite them.",
    "Find >4 top posts and rewrite them.",
    "Find ~4 top posts and rewrite them.",
    "Find 4 x 2 top posts and rewrite them.",
  ])("fails closed for a non-exact source cardinality: %s", (text) => {
    expect(route(text)).toMatchObject({
      kind: "ambiguous_read_only",
      clarificationReason: "modeled_mapping",
    });
  });

  test("keeps output-first source and draft counts independent", () => {
    expect(
      route("Write 3 posts inspired by 5 top sources you find in my swipe file."),
    ).toMatchObject({
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts: 3 },
      minimumSources: 5,
    });
  });

  test.each([
    "Write 3 posts inspired by my top posts in the swipe file.",
    "Write 3 posts in the style of my top posts in the swipe file.",
    "Use 4 top posts from my swipe file as inspiration and write 4 posts.",
  ])("recognizes an explicit output-first modeling relation: %s", (text) => {
    const expectedDrafts = text.includes("4") ? 4 : 3;
    expect(route(text)).toMatchObject({
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts },
      minimumSources: expectedDrafts,
      workspaceDraftSourceMode: "one_to_one",
    });
  });

  test("keeps a malformed modeled skeleton on clarification instead of legacy", () => {
    expect(route('Find 4 top posts in my swipe file and rewrite "each one.')).toMatchObject({
      kind: "ambiguous_read_only",
      clarificationReason: "modeled_mapping",
    });
  });
});
