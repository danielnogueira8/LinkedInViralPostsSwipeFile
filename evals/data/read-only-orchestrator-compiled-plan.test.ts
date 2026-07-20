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
      if (!route || !route.expectsDraft) return;

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

describe("compileServerReadOnlyPlan — per-route shapes", () => {
  test("news_research → one search_news then draft_post", () => {
    const route: ReadOnlyOrchestratorRoute = {
      kind: "news_research",
      expectsDraft: true,
      expectedDrafts: 3,
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
      expectsDraft: true,
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
      expectsDraft: true,
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

  test("compiles regular posts as a post type rather than an account niche", () => {
    const userInstruction =
      "Find 4 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original";
    const route = compileReadOnlyOrchestratorRoute({
      ...routingBase,
      userInstruction,
    });
    expect(route).toMatchObject({
      kind: "workspace_research",
      expectedDrafts: 4,
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
      expectedDrafts: 4,
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
      expectsDraft: true,
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
      expectsDraft: true,
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
      expectsDraft: false,
      clarificationReason: "outcome",
    };
    expect(
      compileServerReadOnlyPlan(route, "Research my swipe file for patterns."),
    ).toBeNull();
  });
});
