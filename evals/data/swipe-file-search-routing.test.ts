import { describe, expect, test } from "vitest";
import { compileReadOnlyOrchestratorRoute } from "@/lib/agent/turn/compile";

// The swipe file (scraped viral posts) is the product's core data. A message
// that asks to search it must ALWAYS route to a real workspace search
// (search_viral_posts), never fall to a conversational lane that replies
// "I don't have access to a swipe file database." Regression for that exact
// production failure.

function route(userInstruction: string) {
  return compileReadOnlyOrchestratorRoute({
    userInstruction,
    isRefine: false,
    hasModelSource: false,
    hasAttachments: false,
    hasLeadMagnet: false,
    hasCreatorStyle: false,
  });
}

describe("swipe-file search always routes to a workspace search", () => {
  // The verbatim message that produced "I don't have access...".
  test("the exact failing message routes to workspace_research", () => {
    expect(
      route("Can you find REAL posts from the swipe file that I could adapt?"),
    ).toMatchObject({ kind: "workspace_research" });
  });

  test.each([
    "Find posts from the swipe file I could adapt.",
    "Search my bookmarks for good hooks.",
    "Show me posts from swipe-in.",
    "Pull some saved posts I can model.",
    "Browse the swipe file for founder-led sales posts.",
    "Get me bookmarks about pricing.",
    "Surface tracked accounts posts on onboarding.",
  ])("routes a swipe-file/bookmark search to workspace_research: %s", (msg) => {
    expect(route(msg)).toMatchObject({ kind: "workspace_research" });
  });

  // An incidental mention with no discovery verb must NOT trigger a search.
  test.each([
    "I love my swipe file, it's so useful.",
    "What is a swipe file?",
    "Thanks for adding that to my bookmarks.",
  ])("does not trigger a search on an incidental mention: %s", (msg) => {
    const r = route(msg);
    expect(r?.kind).not.toBe("workspace_research");
  });

  // A swipe-file search that ALSO asks to write should still draft (the
  // FULL_POST_REQUEST_RE guard wins) — not become a bare answer.
  test("a search-and-write request still produces a draft route", () => {
    const r = route(
      "Find a top post in my swipe file and write an original post in my voice.",
    );
    // workspace_research with a draft outcome, or a modeled draft route — the
    // point is it's NOT a conversational no-op.
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("workspace_research");
  });
});
