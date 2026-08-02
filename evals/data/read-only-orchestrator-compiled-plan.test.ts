import { describe, expect, test } from "vitest";
import {
  compileServerReadOnlyPlan,
  parseReadOnlyPlan,
  planSearchQueriesMatchInstruction,
} from "@/lib/agent/execute/agent";
import {
  compileReadOnlyOrchestratorRoute,
  type ReadOnlyOrchestratorRoute,
} from "@/lib/agent/turn/compile";

// ---------------------------------------------------------------------------
// The read-only orchestrator no longer asks an LLM to produce its action plan.
// The plan is server-compiled deterministically (compileServerReadOnlyPlan)
// from the route the deterministic router already computed. This suite is the
// TEST ORACLE that keeps routing and planning from ever drifting apart: for
// every instruction that the router turns into a draft-producing evidence
// route, the compiled plan MUST pass the exact validators the executor trusts
// (parseReadOnlyPlan + planSearchQueriesMatchInstruction). If a future routing
// change produces a route shape the compiler can't satisfy, a test here goes
// red instead of a real user hitting "I couldn't compile a safe research plan."
//
// Background: that dead-end message came from a flaky LLM planner (a primary
// that dropped the terminal action ~2/3 of the time and a fallback that
// mangled the tool schema 100% of the time), which failed CLOSED. Removing the
// planner removes the entire failure class.
// ---------------------------------------------------------------------------

const routingBase = {
  isRefine: false,
  hasModelSource: false,
  hasAttachments: false,
  hasLeadMagnet: false,
  hasCreatorStyle: false,
};

// Real instructions that route to each evidence kind, INCLUDING the shapes the
// user reported failing ("3 posts"). Each must compile a validator-passing
// plan.
const DRAFT_ROUTE_INSTRUCTIONS: string[] = [
  // news_research
  "Research the latest OpenAI announcement and write a LinkedIn post about what it means for founders.",
  "Research the latest OpenAI news.\n\nWrite 3 LinkedIn posts.",
  "Research OpenAI news and write a LinkedIn post.",
  // web_research
  "Research B2B pricing strategies and write one LinkedIn post about pricing discipline.",
  "Research remote work productivity trends and write 2 LinkedIn posts about it.",
  // workspace_research
  "Find three viral posts from my swipe file, compare their patterns, and write one original post about founder-led sales.",
  "Find three viral SaaS posts, compare them, and write two LinkedIn posts.",
  "Find six viral posts from my swipe file and write one post.",
  "Find ten viral posts from my swipe file and write one post.",
  "Find three viral posts from my swipe file about pricing and write 3 LinkedIn posts.",
];

describe("compileServerReadOnlyPlan — every draft route compiles a validator-passing plan", () => {
  test.each(DRAFT_ROUTE_INSTRUCTIONS)(
    "routes + compiles a plan that passes the executor's validators: %s",
    (userInstruction) => {
      const route = compileReadOnlyOrchestratorRoute({
        ...routingBase,
        userInstruction,
      });
      // These instructions are chosen to route into the orchestrator's draft
      // lanes; if routing itself drops one, that's a routing regression worth
      // catching here too.
      expect(route, `expected a route for: ${userInstruction}`).not.toBeNull();
      if (!route || route.outcome?.kind !== "draft") return;

      const authoritative = route.authoritativeInstruction ?? userInstruction;
      const plan = compileServerReadOnlyPlan(route, authoritative);
      expect(plan, `compiler returned null for: ${userInstruction}`).not.toBeNull();
      if (!plan) return;

      // The two gates the real executor runs on the plan before dispatching it.
      // Neither may throw / return false, for any draft route.
      const validated = parseReadOnlyPlan(route, plan);
      expect(
        planSearchQueriesMatchInstruction(validated, authoritative),
        `query-match validator rejected the compiled plan for: ${userInstruction}`,
      ).toBe(true);

      // A draft route's plan must end in draft_post (never clarify) so the turn
      // actually produces the post the user asked for.
      expect(validated.actions.at(-1)?.type).toBe("draft_post");
    },
  );
});

describe("compileServerReadOnlyPlan — grounded answers keep verified evidence and text separate", () => {
  test.each([
    [
      "Research the latest OpenAI news and summarize what it means for founders.",
      false,
    ],
    ["Research current pricing methods and give me the findings.", false],
    [
      "Find one top-performing regular post in my swipe file about AI agents and summarize why it worked. Do not draft or rewrite.",
      false,
    ],
    ["Summarize the attached interview.", true],
  ] as const)(
    "compiles and validates an answer_from_evidence terminal: %s",
    (userInstruction, hasAttachments) => {
      const route = compileReadOnlyOrchestratorRoute({
        ...routingBase,
        hasAttachments,
        userInstruction,
      });
      expect(route?.outcome?.kind).toBe("grounded_answer");
      if (!route) return;
      const plan = compileServerReadOnlyPlan(route, userInstruction);
      expect(plan?.actions.at(-1)?.type).toBe("answer_from_evidence");
      expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
    },
  );
});

describe("compileServerReadOnlyPlan — source selection is server-owned", () => {
  test("compiles a five-candidate selection without a draft terminal", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "workspace_research",
      outcome: {
        kind: "source_selection",
        candidateCount: 5,
        searchPoolSize: 10,
      },
      minimumSources: 3,
      workspacePostType: "regular",
      workspaceSearchMode: "strict_top",
    };

    const plan = compileServerReadOnlyPlan(
      route,
      "Find a top-performing regular post in my swipe file and rewrite it in my voice.",
    );

    expect(plan?.actions).toMatchObject([
      { type: "search_viral_posts", limit: 10, post_type: "regular" },
      { type: "answer_from_evidence" },
    ]);
    expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
  });
});

describe("compileServerReadOnlyPlan — per-route shapes", () => {
  test("news_research → one search_news then draft_post", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "news_research",
      outcome: { kind: "draft", expectedDrafts: 3 },
    };
    const plan = compileServerReadOnlyPlan(
      route,
      "Research the latest OpenAI news. Write 3 LinkedIn posts.",
    );
    expect(plan?.actions.map((a) => a.type)).toEqual([
      "search_news",
      "draft_post",
    ]);
    // Compiled query is derived from the request, so it survives the validator.
    expect(planSearchQueriesMatchInstruction(
      parseReadOnlyPlan(route, plan!),
      "Research the latest OpenAI news. Write 3 LinkedIn posts.",
    )).toBe(true);
  });

  test("web_research → one search_web then draft_post", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "web_research",
      outcome: { kind: "draft", expectedDrafts: 1 },
    };
    const plan = compileServerReadOnlyPlan(
      route,
      "Research B2B pricing and write a LinkedIn post about pricing discipline.",
    );
    expect(plan?.actions.map((a) => a.type)).toEqual([
      "search_web",
      "draft_post",
    ]);
  });

  test("workspace_research → search_viral_posts covering the minimum sources", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts: 1 },
      minimumSources: 3,
    };
    const plan = compileServerReadOnlyPlan(
      route,
      "Find three viral posts from my swipe file and write 3 LinkedIn posts.",
    );
    const search = plan?.actions.find((a) => a.type === "search_viral_posts");
    expect(search).toBeDefined();
    // The single search's limit must cover the requested minimum so the
    // "must request at least N sources" validator passes.
    expect(
      search?.type === "search_viral_posts" ? search.limit : 0,
    ).toBeGreaterThanOrEqual(3);
    expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
  });

  test("workspace grounded answer → verified search then answer_from_evidence", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "workspace_research",
      minimumSources: 1,
      workspaceSearchMode: "strict_top",
      workspacePostType: "regular",
      outcome: {
        kind: "grounded_answer",
        format: "summary",
        resultCount: 1,
      },
    };
    const instruction =
      "Find one top-performing regular post in my swipe file about AI agents and summarize why it worked. Do not draft or rewrite.";
    const plan = compileServerReadOnlyPlan(route, instruction);

    expect(plan?.actions.map((action) => action.type)).toEqual([
      "search_viral_posts",
      "answer_from_evidence",
    ]);
    expect(
      plan?.actions.find((action) => action.type === "search_viral_posts"),
    ).toMatchObject({
      type: "search_viral_posts",
      query: "AI agents",
      post_type: "regular",
    });
    expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
    expect(planSearchQueriesMatchInstruction(plan!, instruction)).toBe(true);
  });

  test("non-brainstorm workspace research keeps the previous ten-source cap", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "workspace_research",
      minimumSources: 20,
      workspaceSearchMode: "diverse",
      outcome: { kind: "grounded_answer", format: "report" },
    };

    const plan = compileServerReadOnlyPlan(
      route,
      "Compare the strongest saved posts and report the findings.",
    );

    expect(plan?.actions[0]).toMatchObject({
      type: "search_viral_posts",
      limit: 10,
    });
  });

  // Regression: a live production turn for the "Brainstorm new post ideas"
  // starter (chat-workspace.tsx's STARTERS.brainstorm) delivered zero
  // sources — search_viral_posts_candidates_dropped logged
  // dispatched_niche:"Give me". The niche walk-back in
  // authoritativeWorkspaceNicheCandidate had no boundary before "post", so it
  // consumed backward past "5" (not tokenized — single digits fail the
  // 2-char token regex) into the imperative "Give me", misreading it as a
  // workspace niche and searching for zero real posts.
  //
  // Fixed at two layers, deliberately not just a stop-word patch (a
  // stop-word list can only ever cover the SPECIFIC filler words someone
  // thought to list — "Please share", "I'd like", "Can I get" would each
  // need their own entry):
  //  1. WORKSPACE_NICHE_GENERIC_TERMS gained "give"/"me" (and siblings) as a
  //     baseline boundary — still useful when no workspace niche data is
  //     available (e.g. these route objects below omit it).
  //  2. authoritativeWorkspaceNicheCandidate now accepts a `knownNiches`
  //     param (threaded from compileServerReadOnlyPlan /
  //     planSearchQueriesMatchInstruction / authorizedWorkspaceNiche): when
  //     supplied, a candidate must semantically match a REAL workspace
  //     niche or it's rejected outright — closing the whole class of
  //     unlisted-filler-word false positives, not just this instance. See
  //     the "knownNiches grounds extraction in real data" block below for
  //     the layer-2 coverage.
  test("an imperative 'Give me N post ideas' opener never leaks into niche", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "workspace_research",
      minimumSources: 5,
      workspaceSearchMode: "diverse",
      workspaceSince: "30d",
      outcome: {
        kind: "brainstorm_ideas",
        ideaCount: 5,
        searchPoolSize: 20,
      },
    };
    const instruction =
      "Give me 5 post ideas based on what's been going viral across my tracked accounts over the last 30 days. Pull from ALL niches — don't ask me which niche, and don't limit it to mine. Adapt every idea to my voice and my niche. For each, give a one-line angle and the hook style it would use.";
    const plan = compileServerReadOnlyPlan(route, instruction);

    const search = plan?.actions.find(
      (action) => action.type === "search_viral_posts",
    );
    expect(search).not.toHaveProperty("niche");
    expect(search).not.toHaveProperty("query");
    expect(search).toMatchObject({ limit: 20 });
    expect(plan?.actions.at(-1)).toMatchObject({
      type: "answer_from_evidence",
      format: "ideas",
      resultCount: 5,
    });
    expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
    expect(planSearchQueriesMatchInstruction(plan!, instruction)).toBe(true);
  });

  test.each([
    "Show me 3 post ideas from my swipe file.",
    "Find me the top post ideas from the last month.",
    "Get me 5 post examples from my tracked accounts.",
  ])(
    "other imperative openers before 'post(s)' also compile with no niche: %s",
    (instruction) => {
      const route: ReadOnlyOrchestratorRoute = {
        kind: "workspace_research",
        minimumSources: 3,
        workspaceSearchMode: "strict_top",
        outcome: { kind: "grounded_answer", format: "takeaways", resultCount: 3 },
      };
      const plan = compileServerReadOnlyPlan(route, instruction);
      const search = plan?.actions.find(
        (action) => action.type === "search_viral_posts",
      );
      expect(search).not.toHaveProperty("niche");
    },
  );

  // Layer 2 of the "Give me" fix (see the regression comment above): when the
  // workspace's real niches are known, extraction is grounded in that data
  // instead of the stop-word list — the structural fix, not the patch.
  describe("knownNiches grounds extraction in real data", () => {
    const WORKSPACE_NICHES = ["SaaS", "Founder Stories", "AI Agents"];

    test("a real workspace niche still compiles even with an imperative opener", () => {
      const route: ReadOnlyOrchestratorRoute = {
        kind: "workspace_research",
        minimumSources: 2,
        workspaceSearchMode: "strict_top",
        outcome: { kind: "grounded_answer", format: "takeaways", resultCount: 2 },
      };
      const instruction = "Give me 2 SaaS post ideas from my swipe file.";
      const plan = compileServerReadOnlyPlan(route, instruction, WORKSPACE_NICHES);

      expect(
        plan?.actions.find((action) => action.type === "search_viral_posts"),
      ).toMatchObject({ type: "search_viral_posts", niche: "SaaS" });
      expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
      expect(
        planSearchQueriesMatchInstruction(plan!, instruction, WORKSPACE_NICHES),
      ).toBe(true);
    });

    // The whole point of layer 2: an UNLISTED filler word (not in
    // WORKSPACE_NICHE_GENERIC_TERMS, so layer 1 alone would still misparse
    // it) is rejected once real niche data is available, because it matches
    // none of the workspace's actual niches.
    test("an unlisted filler word before 'post(s)' is rejected once real niches are known", () => {
      const route: ReadOnlyOrchestratorRoute = {
        kind: "workspace_research",
        minimumSources: 3,
        workspaceSearchMode: "strict_top",
        outcome: { kind: "grounded_answer", format: "takeaways", resultCount: 3 },
      };
      const instruction =
        "Please share 3 post ideas based on what's been going viral.";
      const plan = compileServerReadOnlyPlan(route, instruction, WORKSPACE_NICHES);

      const search = plan?.actions.find(
        (action) => action.type === "search_viral_posts",
      );
      expect(search).not.toHaveProperty("niche");
      expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
      expect(
        planSearchQueriesMatchInstruction(plan!, instruction, WORKSPACE_NICHES),
      ).toBe(true);
    });

    test("a niche-shaped phrase that matches no real workspace niche is dropped, not invented", () => {
      const route: ReadOnlyOrchestratorRoute = {
        kind: "workspace_research",
        minimumSources: 2,
        workspaceSearchMode: "strict_top",
        outcome: { kind: "grounded_answer", format: "takeaways", resultCount: 2 },
      };
      // "Crypto" reads exactly like a real niche name, but isn't one of this
      // workspace's tracked niches — must be omitted, never hallucinated.
      const instruction = "Find 2 Crypto post ideas from my swipe file.";
      const plan = compileServerReadOnlyPlan(route, instruction, WORKSPACE_NICHES);

      const search = plan?.actions.find(
        (action) => action.type === "search_viral_posts",
      );
      expect(search).not.toHaveProperty("niche");
    });
  });

  test("compiles regular posts as a post type rather than an account niche", () => {
    const userInstruction =
      "Find 4 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original";
    const route = compileReadOnlyOrchestratorRoute({
      ...routingBase,
      userInstruction,
    });
    expect(route).toMatchObject({
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts: 4 },
      minimumSources: 4,
      workspacePostType: "regular",
    });
    if (!route) return;

    const plan = compileServerReadOnlyPlan(route, userInstruction);
    const search = plan?.actions.find(
      (action) => action.type === "search_viral_posts",
    );
    expect(search).toMatchObject({
      type: "search_viral_posts",
      limit: 4,
      post_type: "regular",
    });
    expect(search).not.toHaveProperty("niche");
    expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
  });

  test("keeps an account niche orthogonal to a requested post type", () => {
    const userInstruction =
      "Find 4 top SaaS lead magnet posts in my swipe file and adapt them into original posts.";
    const route = compileReadOnlyOrchestratorRoute({
      ...routingBase,
      userInstruction,
    });
    expect(route).toMatchObject({
      kind: "workspace_research",
      outcome: { kind: "draft", expectedDrafts: 4 },
      minimumSources: 4,
      workspacePostType: "lead_magnet",
    });
    if (!route) return;

    const plan = compileServerReadOnlyPlan(route, userInstruction);
    expect(
      plan?.actions.find((action) => action.type === "search_viral_posts"),
    ).toMatchObject({
      type: "search_viral_posts",
      niche: "SaaS",
      post_type: "lead_magnet",
      limit: 4,
    });
  });

  test("file_inspection with an allowed workspace search compiles both actions", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "file_inspection",
      outcome: { kind: "draft", expectedDrafts: 1 },
      allowExternalSearch: true,
      allowedSearchKinds: ["workspace"],
      minimumSources: 2,
    };
    const plan = compileServerReadOnlyPlan(
      route,
      "Inspect the attached brief and, using my swipe file, write a LinkedIn post.",
    );
    const types = plan?.actions.map((a) => a.type) ?? [];
    expect(types).toContain("inspect_attachments");
    expect(types).toContain("search_viral_posts");
    expect(types.at(-1)).toBe("draft_post");
    expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
  });

  test("file_inspection with no allowed search compiles inspect + draft only", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "file_inspection",
      outcome: { kind: "draft", expectedDrafts: 1 },
      allowExternalSearch: false,
      allowedSearchKinds: [],
    };
    const plan = compileServerReadOnlyPlan(
      route,
      "Inspect the attached interview and write a LinkedIn post from it.",
    );
    expect(plan?.actions.map((a) => a.type)).toEqual([
      "inspect_attachments",
      "draft_post",
    ]);
    expect(() => parseReadOnlyPlan(route, plan!)).not.toThrow();
  });

  test("ambiguous_read_only is not compiled here (caller emits the clarify)", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "ambiguous_read_only",
      clarificationReason: "outcome",
    };
    expect(
      compileServerReadOnlyPlan(route, "Research my swipe file for patterns."),
    ).toBeNull();
  });
});
