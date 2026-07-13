import { describe, test, expect } from "vitest";
import {
  kindNoun,
  labelArtifacts,
  panelTitle,
  prettyToolName,
  toolDetail,
  agentStatus,
  refineSuggestions,
} from "@/lib/chat-ui-policy";
import type { Artifact } from "@/lib/agent/contracts";
import type { Message } from "@/lib/chat-hydration";

// ---------------------------------------------------------------------------
// Chat-interaction rendering logic: how drafts are numbered/labeled, the panel
// header, the activity-stream tool narration, and the live "Working/Planning"
// status line. All pure — previously untested. labelArtifacts in particular
// caused a real "Draft N" numbering bug, so it's pinned hard.
// ---------------------------------------------------------------------------

const art = (kind: Artifact["kind"], body = "b"): Artifact => ({
  id: `${kind}_${Math.round(body.length)}_${body}`,
  kind,
  title: body.slice(0, 20),
  body,
});

describe("kindNoun", () => {
  test("hook → Hook, post → Draft, cite → Draft", () => {
    expect(kindNoun("hook")).toBe("Hook");
    expect(kindNoun("post")).toBe("Draft");
    expect(kindNoun("cite")).toBe("Draft");
  });
});

describe("labelArtifacts — Draft/Hook numbering", () => {
  test("a lone draft is just 'Draft' (no number)", () => {
    const out = labelArtifacts([art("post", "x")]);
    expect(out.map((o) => o.label)).toEqual(["Draft"]);
  });

  test("a lone hook is just 'Hook'", () => {
    expect(labelArtifacts([art("hook", "x")]).map((o) => o.label)).toEqual(["Hook"]);
  });

  test("multiple posts → Draft 1, Draft 2, Draft 3 in creation order", () => {
    const out = labelArtifacts([art("post", "a"), art("post", "b"), art("post", "c")]);
    expect(out.map((o) => o.label)).toEqual(["Draft 1", "Draft 2", "Draft 3"]);
  });

  test("multiple hooks → Hook 1..N", () => {
    const out = labelArtifacts([art("hook", "a"), art("hook", "b")]);
    expect(out.map((o) => o.label)).toEqual(["Hook 1", "Hook 2"]);
  });

  test("mixed kinds number WITHIN each kind independently", () => {
    // 2 posts + 2 hooks interleaved → each numbered within its own kind.
    const out = labelArtifacts([
      art("post", "p1"),
      art("hook", "h1"),
      art("post", "p2"),
      art("hook", "h2"),
    ]);
    expect(out.map((o) => o.label)).toEqual(["Draft 1", "Hook 1", "Draft 2", "Hook 2"]);
  });

  test("a single post + a single hook each stay unnumbered", () => {
    const out = labelArtifacts([art("post", "p"), art("hook", "h")]);
    expect(out.map((o) => o.label)).toEqual(["Draft", "Hook"]);
  });

  test("returns artifacts in creation order (caller reverses for display)", () => {
    const a = art("post", "first");
    const b = art("post", "second");
    expect(labelArtifacts([a, b]).map((o) => o.a.body)).toEqual(["first", "second"]);
  });
});

describe("panelTitle", () => {
  test("posts only → Drafts", () => {
    expect(panelTitle([art("post"), art("post")])).toBe("Drafts");
  });
  test("hooks only → Hooks", () => {
    expect(panelTitle([art("hook")])).toBe("Hooks");
  });
  test("both → Drafts & Hooks", () => {
    expect(panelTitle([art("post"), art("hook")])).toBe("Drafts & Hooks");
  });
  test("empty → Drafts (default)", () => {
    expect(panelTitle([])).toBe("Drafts");
  });
});

describe("prettyToolName", () => {
  test("underscores become spaces", () => {
    expect(prettyToolName("search_viral_posts")).toBe("search viral posts");
    expect(prettyToolName("get_voice")).toBe("get voice");
  });
});

describe("toolDetail — human detail from tool args", () => {
  test("search_viral_posts surfaces the niche", () => {
    expect(toolDetail("search_viral_posts", JSON.stringify({ niche: "SaaS" }))).toBe("SaaS");
  });
  test("search_viral_posts shows niche · lead magnets for lead_magnet type", () => {
    expect(
      toolDetail("search_viral_posts", JSON.stringify({ niche: "AI", post_type: "lead_magnet" })),
    ).toBe("AI · lead magnets");
  });
  test("search_viral_posts with a non-lead-magnet type just shows the niche", () => {
    expect(
      toolDetail("search_viral_posts", JSON.stringify({ niche: "AI", post_type: "regular" })),
    ).toBe("AI");
  });
  test("list_accounts surfaces the niche", () => {
    expect(toolDetail("list_accounts", JSON.stringify({ niche: "Outreach" }))).toBe("Outreach");
  });
  test("never surfaces internal params (limit, sort) — only audience-meaningful ones", () => {
    expect(toolDetail("search_viral_posts", JSON.stringify({ limit: 10, sort: "viral" }))).toBe("");
  });
  test("truncated / invalid JSON → empty (no detail mid-stream)", () => {
    expect(toolDetail("search_viral_posts", '{"niche":"AI')).toBe("");
    expect(toolDetail("search_viral_posts", "not json")).toBe("");
  });
  test("empty args → empty", () => {
    expect(toolDetail("search_viral_posts", "")).toBe("");
    expect(toolDetail("get_voice", "{}")).toBe("");
  });
  test("a blank/whitespace value is treated as absent", () => {
    expect(toolDetail("search_viral_posts", JSON.stringify({ niche: "   " }))).toBe("");
  });
});

describe("agentStatus — the live status line", () => {
  const m = (over: Partial<Message>): Message => ({
    id: "a",
    role: "assistant",
    text: "",
    streaming: true,
    ...over,
  });

  test("not streaming → null (no status)", () => {
    expect(agentStatus(m({ streaming: false }))).toBeNull();
  });

  test("streaming, nothing happened yet → 'Planning next moves'", () => {
    expect(agentStatus(m({ tools: [], text: "" }))).toBe("Planning next moves");
  });

  test("a running tool → that tool's present-tense phrase", () => {
    const out = agentStatus(
      m({ tools: [{ id: "t", name: "search_viral_posts", ok: undefined }] }),
    );
    expect(out).toBe("Searching the swipe file");
  });

  test("an unknown running tool → generic 'Working'", () => {
    const out = agentStatus(m({ tools: [{ id: "t", name: "mystery_tool", ok: undefined }] }));
    expect(out).toBe("Working");
  });

  test("no running tool but there IS text → steady 'Working' (covers think-gaps)", () => {
    expect(agentStatus(m({ tools: [], text: "Here's a thought…" }))).toBe("Working");
  });

  test("no running tool but a finished tool exists → 'Working'", () => {
    expect(agentStatus(m({ tools: [{ id: "t", name: "get_voice", ok: true }] }))).toBe("Working");
  });
});

describe("refineSuggestions", () => {
  test("hooks get hook-specific quick refines", () => {
    expect(refineSuggestions("hook")).toContain("More contrarian");
  });
  test("posts get post-specific quick refines", () => {
    expect(refineSuggestions("post")).toContain("Stronger CTA");
  });
});
