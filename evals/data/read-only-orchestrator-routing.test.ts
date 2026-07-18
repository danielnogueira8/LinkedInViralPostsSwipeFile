import { describe, expect, test } from "vitest";
import {
  compileReadOnlyOrchestratorRoute,
  compileReadOnlyOrchestratorReserveRoute,
  readOnlyOrchestratorEnabledForWorkspace,
} from "@/lib/agent/read-only-orchestrator-routing";

const base = {
  isRefine: false,
  hasModelSource: false,
  hasAttachments: false,
  hasLeadMagnet: false,
  hasCreatorStyle: false,
};

describe("read-only complex orchestrator routing", () => {
  test.each([
    [
      "news_research",
      "Research the latest OpenAI announcement and write a LinkedIn post about what it means for founders.",
    ],
    [
      "workspace_research",
      "Find three viral posts from my swipe file, compare their patterns, and write one original post about founder-led sales.",
    ],
    [
      "web_research",
      "Research B2B pricing strategies and write one LinkedIn post about pricing discipline.",
    ],
  ] as const)("compiles %s only for a complex grounded writing turn", (kind, userInstruction) => {
    expect(
      compileReadOnlyOrchestratorRoute({ ...base, userInstruction }),
    ).toMatchObject({ kind, expectsDraft: true });
  });

  test("routes a writing turn that must inspect an attachment", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        hasAttachments: true,
        userInstruction:
          "Inspect the attached customer interview and write a LinkedIn post from the verified lessons in it.",
      }),
    ).toMatchObject({ kind: "file_inspection", expectsDraft: true });
  });

  test("preserves an exact plural output count on a complex research route", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction:
          "Research the latest OpenAI announcement and write two LinkedIn posts.",
      }),
    ).toMatchObject({
      kind: "news_research",
      expectsDraft: true,
      expectedDrafts: 2,
    });
  });

  test("does not mistake an output count for the requested research source count", () => {
    const route = compileReadOnlyOrchestratorRoute({
      ...base,
      userInstruction:
        "Find three viral SaaS posts, compare them, and write two LinkedIn posts.",
    });
    expect(route).toMatchObject({
      kind: "workspace_research",
      expectedDrafts: 2,
      minimumSources: 3,
    });
    expect(route).not.toHaveProperty("workspaceDraftSourceMode");
  });

  test("does not mistake plural research sources for a plural output", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction:
          "Find three viral SaaS posts and write a LinkedIn post about pricing.",
      }),
    ).toMatchObject({
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: 1,
      minimumSources: 3,
    });
  });

  test.each([
    [
      "Find one top-performing regular post in my swipe file and rewrite it in my voice on a topic that fits me.",
      1,
      "regular",
    ],
    [
      "Find 4 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original",
      4,
      "regular",
    ],
    [
      "Find 5 top-performing lead magnet posts in my swipe file and adapt them into original posts in my voice.",
      5,
      "lead_magnet",
    ],
    [
      "Find 3 top-performing regular posts in my swipe file and create 3 posts modeled after them.",
      3,
      "regular",
    ],
    [
      "Find 3 top-performing regular posts in my swipe file and write three posts modelling their formats.",
      3,
      "regular",
    ],
    [
      "Find 3 top-performing regular posts in my swipe file and replicate their formats in three posts.",
      3,
      "regular",
    ],
    [
      "Find 4 top-performing regular posts in my swipe file and turn them into original posts.",
      4,
      "regular",
    ],
  ] as const)(
    "preserves a one-to-one source transformation contract: %s",
    (userInstruction, expectedDrafts, workspacePostType) => {
      expect(
        compileReadOnlyOrchestratorRoute({ ...base, userInstruction }),
      ).toMatchObject({
        kind: "workspace_research",
        expectsDraft: true,
        expectedDrafts,
        minimumSources: expectedDrafts,
        workspacePostType,
        workspaceDraftSourceMode: "one_to_one",
      });
    },
  );

  test("clarifies an uncounted plural workspace output despite compare language", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction:
          "Find viral posts from my swipe file, compare them, and write LinkedIn posts about pricing.",
      }),
    ).toMatchObject({ kind: "ambiguous_read_only", expectsDraft: false });
  });

  test.each([
    "Find 3 top posts and turn them into a comparison table.",
    "Find 3 top posts and turn them into a research summary.",
    "Find 3 top posts and turn each one into a slide.",
  ])("never routes a non-post transformation as one-to-one drafts: %s", (userInstruction) => {
    expect(
      compileReadOnlyOrchestratorRoute({ ...base, userInstruction }),
    ).not.toMatchObject({
      expectsDraft: true,
      workspaceDraftSourceMode: "one_to_one",
    });
  });

  test.each([
    ["Find three viral SaaS posts, compare them, and write one post.", 3],
    ["Find several viral SaaS posts, compare them, and write one post.", 3],
    ["Find multiple viral SaaS posts, compare them, and write one post.", 2],
    [
      "Write one LinkedIn post after finding and comparing three viral posts.",
      3,
    ],
    ["Find six viral posts from my swipe file and write one post.", 6],
    ["Find ten viral posts from my swipe file and write one post.", 10],
    [
      "Find and review three of my best performing saved LinkedIn posts, then write one post about positioning.",
      3,
    ],
  ])("compiles the requested multi-source minimum: %s", (userInstruction, minimumSources) => {
    expect(
      compileReadOnlyOrchestratorRoute({ ...base, userInstruction }),
    ).toMatchObject({
      kind: "workspace_research",
      expectsDraft: true,
      minimumSources,
    });
  });

  test("still inspects an attachment when the user explicitly forbids external search", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        hasAttachments: true,
        userInstruction:
          "Inspect the attached interview and write a LinkedIn post from it. Do not search the web.",
      }),
    ).toMatchObject({
      kind: "file_inspection",
      expectsDraft: true,
      allowExternalSearch: false,
      allowedSearchKinds: [],
    });
  });

  test("permits only the search capability explicitly requested alongside a file", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        hasAttachments: true,
        userInstruction:
          "Inspect the attached brief, research the latest OpenAI news, and write one LinkedIn post.",
      }),
    ).toMatchObject({
      kind: "file_inspection",
      allowedSearchKinds: ["news"],
    });
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        hasAttachments: true,
        userInstruction:
          "Inspect the attached brief and write one LinkedIn post.",
      }),
    ).toMatchObject({
      kind: "file_inspection",
      allowedSearchKinds: [],
    });
  });

  test.each([
    "Write a LinkedIn post about our latest product launch and what we learned.",
    "Write a LinkedIn post about my recent launch.",
    "Write a LinkedIn post about a recent development in my career.",
  ])("keeps first-party recency language on the direct writer: %s", (userInstruction) => {
    expect(
      compileReadOnlyOrchestratorRoute({ ...base, userInstruction }),
    ).toBeNull();
  });

  test.each([
    "Research OpenAI news and write a LinkedIn post.",
    "Search for news about OpenAI and write a LinkedIn post.",
    "Research the latest news from my industry and write a LinkedIn post.",
  ])("uses the freshness-enforced news route for explicit news research: %s", (userInstruction) => {
    expect(
      compileReadOnlyOrchestratorRoute({ ...base, userInstruction }),
    ).toMatchObject({ kind: "news_research", expectsDraft: true });
  });

  test.each([
    "Research news and write a LinkedIn post.",
    "Research the latest announcement and write a LinkedIn post.",
  ])("asks for a missing research topic without spending planner calls: %s", (userInstruction) => {
    expect(
      compileReadOnlyOrchestratorRoute({ ...base, userInstruction }),
    ).toMatchObject({
      kind: "ambiguous_read_only",
      clarificationReason: "research_topic",
    });
  });

  test("keeps history-dependent research on the history-aware baseline", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction: "Research this further and write a LinkedIn post.",
      }),
    ).toBeNull();
  });

  test("recompiles an outcome clarification answer into the original grounded lane", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction:
          "Research the latest OpenAI news.\n\nClarification answer: A LinkedIn post",
      }),
    ).toMatchObject({
      kind: "news_research",
      expectsDraft: true,
      authoritativeInstruction:
        "Research the latest OpenAI news.\n\nWrite a LinkedIn post.",
    });
  });

  test("preserves a clear plural count from an outcome clarification", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction:
          "Research the latest OpenAI news.\n\nClarification answer: Two LinkedIn posts",
      }),
    ).toMatchObject({
      kind: "news_research",
      expectedDrafts: 2,
      authoritativeInstruction:
        "Research the latest OpenAI news.\n\nWrite 2 LinkedIn posts.",
    });
  });

  test.each([
    "A Twitter post",
    "Not a LinkedIn post; give takeaways",
    "Seven LinkedIn posts",
  ])("does not rewrite an unsupported outcome answer: %s", (answer) => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction: `Research the latest OpenAI news.\n\nClarification answer: ${answer}`,
      }),
    ).toBeNull();
  });

  // Regression: a user answering "How many LinkedIn posts?" naturally drops
  // the word "LinkedIn" ("3 posts") or answers with just the bare count
  // ("3", "three") — the strict "linkedin posts" match silently failed the
  // whole clarification resolution for these, falling the turn out of the
  // orchestrator (and, upstream, into a "couldn't compile a safe research
  // plan" failure once the turn no longer carried the user's stated count).
  test.each([
    ["3 posts", 3],
    ["three posts", 3],
    ["3", 3],
    ["Three", 3],
    ["3 LinkedIn Posts", 3],
  ])(
    "resolves a natural bare-count outcome answer without the word 'LinkedIn': %s",
    (answer, expectedDrafts) => {
      expect(
        compileReadOnlyOrchestratorRoute({
          ...base,
          userInstruction: `Research the latest OpenAI news.\n\nClarification answer: ${answer}`,
        }),
      ).toMatchObject({
        kind: "news_research",
        expectedDrafts,
        authoritativeInstruction: `Research the latest OpenAI news.\n\nWrite ${expectedDrafts} LinkedIn posts.`,
      });
    },
  );

  test.each(["seven posts", "seven", "0", "0 posts"])(
    "still rejects an out-of-range or invalid bare-count answer: %s",
    (answer) => {
      expect(
        compileReadOnlyOrchestratorRoute({
          ...base,
          userInstruction: `Research the latest OpenAI news.\n\nClarification answer: ${answer}`,
        }),
      ).toBeNull();
    },
  );

  test("recompiles a research-topic answer without repeating the clarification", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction:
          "Research news and write a LinkedIn post.\n\nClarification answer: OpenAI",
      }),
    ).toMatchObject({
      kind: "news_research",
      expectsDraft: true,
      authoritativeInstruction:
        "Research OpenAI news and write a LinkedIn post.",
    });
  });

  test("compiles strict top ranking as a server-owned workspace constraint", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction:
          "Find the top three viral posts in my swipe file and write one LinkedIn post.",
      }),
    ).toMatchObject({
      kind: "workspace_research",
      minimumSources: 3,
      workspaceSearchMode: "strict_top",
    });
  });

  test("compiles a requested workspace freshness window server-side", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        userInstruction:
          "Find three recent SaaS posts in my swipe file and write one LinkedIn post.",
      }),
    ).toMatchObject({
      kind: "workspace_research",
      workspaceSince: "30d",
    });
  });

  test("preserves workspace count and ranking when file inspection is also required", () => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        hasAttachments: true,
        userInstruction:
          "Inspect the attached brief, find the top five viral SaaS posts, and write one LinkedIn post.",
      }),
    ).toMatchObject({
      kind: "file_inspection",
      allowedSearchKinds: ["workspace"],
      minimumSources: 5,
      workspaceSearchMode: "strict_top",
    });
  });

  test.each([
    "Research the latest OpenAI news.",
    "Find the best examples in my swipe file.",
  ])("routes an unresolved complex read-only turn to clarification: %s", (userInstruction) => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        hasAttachments: userInstruction.includes("attached"),
        userInstruction,
      }),
    ).toMatchObject({ kind: "ambiguous_read_only", expectsDraft: false });
  });

  test.each([
    "Compare the attached files and tell me what I should do next.",
    "Summarize the attached interview.",
    "Research current pricing methods and give me the findings.",
  ])("keeps a clear non-post read-only deliverable on the baseline: %s", (userInstruction) => {
    expect(
      compileReadOnlyOrchestratorRoute({
        ...base,
        hasAttachments: userInstruction.includes("attached"),
        userInstruction,
      }),
    ).toBeNull();
  });

  test.each([
    "Write an original post in my voice about career leverage.",
    "Write two original posts about career leverage.",
    "Write a post about career leverage. Do not search or use sources.",
    "Find one viral post and write one LinkedIn post based on its structure.",
  ])("keeps a direct-writing journey off the orchestrator: %s", (userInstruction) => {
    expect(
      compileReadOnlyOrchestratorRoute({ ...base, userInstruction }),
    ).toBeNull();
  });

  test.each([
    {
      userInstruction: "Research pricing and write a post, then schedule it for Friday.",
    },
    {
      userInstruction: "Research pricing and rewrite this draft.",
      isRefine: true,
    },
    {
      userInstruction: "Research pricing and model the selected source post.",
      hasModelSource: true,
    },
  ])("does not absorb action or already-owned writing lanes", (overrides) => {
    expect(
      compileReadOnlyOrchestratorRoute({ ...base, ...overrides }),
    ).toBeNull();
  });

  test("reserves the orchestrator when an optional lead magnet may later be ignored", () => {
    const input = {
      ...base,
      hasLeadMagnet: true,
      userInstruction:
        "Research the latest OpenAI announcement and write a LinkedIn post about it.",
    };

    expect(compileReadOnlyOrchestratorRoute(input)).toBeNull();
    expect(compileReadOnlyOrchestratorReserveRoute(input)).toMatchObject({
      kind: "news_research",
      expectsDraft: true,
    });
  });

  test("uses an allowlist plus an immediate kill switch", () => {
    const env = {
      COWORK_READ_ONLY_ORCHESTRATOR_ENABLED: "1",
      COWORK_READ_ONLY_ORCHESTRATOR_WORKSPACES: "ws-a,ws-b",
    };
    expect(readOnlyOrchestratorEnabledForWorkspace("ws-a", env)).toBe(true);
    expect(readOnlyOrchestratorEnabledForWorkspace("ws-c", env)).toBe(false);
    expect(
      readOnlyOrchestratorEnabledForWorkspace("ws-a", {
        ...env,
        COWORK_READ_ONLY_ORCHESTRATOR_KILL_SWITCH: "1",
      }),
    ).toBe(false);
  });

  test("can be selected by the shared stable percentage rollout", () => {
    expect(
      readOnlyOrchestratorEnabledForWorkspace("ws-sampled", {
        COWORK_V2_ENABLED: "1",
        COWORK_V2_ROLLOUT_MODE: "sample",
        COWORK_V2_ROLLOUT_PERCENT: "100",
      }),
    ).toBe(true);
  });
});
