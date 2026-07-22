import { describe, test, expect } from "vitest";
import {
  ARTIFACT_PANEL_TITLE,
  buildArtifactIndex,
  kindNoun,
  prettyToolName,
  planProgressTitle,
  toolDetail,
  agentStatus,
  activityTailLabel,
  refineSuggestions,
  visibleActivityTools,
  resolveArtifactEditTarget,
  resolveArtifactReference,
} from "@/lib/chat-ui-policy";
import type { Artifact } from "@/lib/agent/contracts";
import type { Message } from "@/lib/chat-hydration";

// ---------------------------------------------------------------------------
// Chat-interaction rendering logic: how drafts are numbered/labeled, the panel
// header, the activity-stream tool narration, and the live "Working/Planning"
// status line. All pure — previously untested. Artifact indexing in particular
// caused a real numbering bug, so it's pinned hard.
// ---------------------------------------------------------------------------

const art = (kind: Artifact["kind"], body = "b"): Artifact => ({
  id: `${kind}_${Math.round(body.length)}_${body}`,
  kind,
  title: body.slice(0, 20),
  body,
});

describe("kindNoun", () => {
  test("uses plain-language vocabulary for every conversation deliverable", () => {
    expect(kindNoun("hook")).toBe("Hook");
    expect(kindNoun("post")).toBe("Post");
    expect(kindNoun("cite")).toBe("Source");
  });
});

describe("buildArtifactIndex — Post/Hook numbering", () => {
  test("a lone post is just 'Post' (no number)", () => {
    const out = buildArtifactIndex([art("post", "x")]).entries;
    expect(out.map((o) => o.label)).toEqual(["Post"]);
  });

  test("a lone hook is just 'Hook'", () => {
    expect(
      buildArtifactIndex([art("hook", "x")]).entries.map((o) => o.label),
    ).toEqual(["Hook"]);
  });

  test("multiple posts are numbered in creation order", () => {
    const out = buildArtifactIndex([
      art("post", "a"),
      art("post", "b"),
      art("post", "c"),
    ]).entries;
    expect(out.map((o) => o.label)).toEqual([
      "Post 1",
      "Post 2",
      "Post 3",
    ]);
  });

  test("multiple hooks are numbered in creation order", () => {
    const out = buildArtifactIndex([art("hook", "a"), art("hook", "b")]).entries;
    expect(out.map((o) => o.label)).toEqual([
      "Hook 1",
      "Hook 2",
    ]);
  });

  test("mixed kinds number WITHIN each kind independently", () => {
    // 2 posts + 2 hooks interleaved → each numbered within its own kind.
    const out = buildArtifactIndex([
      art("post", "p1"),
      art("hook", "h1"),
      art("post", "p2"),
      art("hook", "h2"),
    ]).entries;
    expect(out.map((o) => o.label)).toEqual([
      "Post 1",
      "Hook 1",
      "Post 2",
      "Hook 2",
    ]);
  });

  test("a single post + a single hook each stay unnumbered", () => {
    const out = buildArtifactIndex([art("post", "p"), art("hook", "h")]).entries;
    expect(out.map((o) => o.label)).toEqual([
      "Post",
      "Hook",
    ]);
  });

  test("returns artifacts in creation order (caller reverses for display)", () => {
    const a = art("post", "first");
    const b = art("post", "second");
    expect(
      buildArtifactIndex([a, b]).entries.map((o) => o.artifact.body),
    ).toEqual(["first", "second"]);
  });
});

describe("shared Artifact index", () => {
  test("deduplicates a re-emitted Artifact while preserving its original ordinal", () => {
    const original = { ...art("post", "first"), id: "artifact-1" };
    const updated = { ...original, body: "updated body" };
    const second = { ...art("post", "second"), id: "artifact-2" };

    expect(buildArtifactIndex([original, updated, second]).entries).toEqual([
      expect.objectContaining({
        artifactId: "artifact-1",
        ordinal: 1,
        label: "Post 1",
        artifact: updated,
      }),
      expect.objectContaining({
        artifactId: "artifact-2",
        ordinal: 2,
        label: "Post 2",
        artifact: second,
      }),
    ]);
  });

  test("Edit fills a missing target but never retargets a stale explicit selection", () => {
    const entries = buildArtifactIndex([
      { ...art("post", "first post"), id: "post-1" },
      { ...art("post", "second post"), id: "post-2" },
    ]).entries;

    expect(
      resolveArtifactEditTarget(entries, { expandedArtifactId: "post-1" }),
    ).toMatchObject({ artifactId: "post-1" });
    expect(resolveArtifactEditTarget(entries, {})).toMatchObject({
      artifactId: "post-2",
    });
    expect(
      resolveArtifactEditTarget(entries, {
        targetArtifactId: "deleted-post",
        expandedArtifactId: "post-1",
      }),
    ).toBeUndefined();
  });

  test("resolves UI labels, selected context, and missing explicit references", () => {
    const artifacts = [
      { ...art("hook", "first hook"), id: "hook-1" },
      { ...art("post", "first post"), id: "post-1" },
      { ...art("post", "second post"), id: "post-2" },
    ];

    expect(resolveArtifactReference("Review Draft 1", artifacts, "post-2"))
      .toEqual({ kind: "selected", artifactId: "post-1" });
    expect(resolveArtifactReference("Review Post 2", artifacts, null))
      .toEqual({ kind: "selected", artifactId: "post-2" });
    expect(resolveArtifactReference("Improve this", artifacts, "post-1"))
      .toEqual({ kind: "selected", artifactId: "post-1" });
    expect(resolveArtifactReference("Review Draft 9", artifacts, null))
      .toEqual({ kind: "unresolved_explicit", reference: "Post 9" });
  });

  test("does not silently replace a stale selected Artifact with the latest one", () => {
    expect(
      resolveArtifactReference(
        "Make this punchier",
        [
          { ...art("post", "one"), id: "post-1" },
          { ...art("post", "two"), id: "post-2" },
        ],
        "deleted-draft",
      ),
    ).toEqual({
      kind: "unresolved_explicit",
      reference: "the selected post",
    });
  });
});

describe("ARTIFACT_PANEL_TITLE", () => {
  test("uses the human-facing post noun", () => {
    expect(ARTIFACT_PANEL_TITLE).toBe("Posts");
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

  test.each([
    ["search_web", "Researching verified sources"],
    ["inspect_attachments", "Inspecting your attachments"],
    ["write_grounded_post", "Writing and checking your post"],
  ])("narrates orchestrator action %s cleanly", (name, expected) => {
    expect(
      agentStatus(m({ tools: [{ id: "t", name, ok: undefined }] })),
    ).toBe(expected);
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

describe("activityTailLabel — work after the last tool settles", () => {
  test("does not claim a post is being written when research may be for ideas", () => {
    expect(
      activityTailLabel(
        [
          { id: "voice", name: "get_voice", ok: true },
          { id: "posts", name: "get_top_from_batch", ok: true },
        ],
        "Working",
      ),
    ).toBe("Preparing your response");
  });

  test("uses an honest generic label for other completed tool sequences", () => {
    expect(
      activityTailLabel(
        [{ id: "accounts", name: "list_accounts", ok: true }],
        "Working",
      ),
    ).toBe("Preparing your response");
  });

  test("does not add a duplicate spinner while a real tool is running", () => {
    expect(
      activityTailLabel(
        [{ id: "posts", name: "get_top_from_batch", ok: undefined }],
        "Pulling the latest top posts",
      ),
    ).toBeNull();
  });

  test("does not show background work after the turn settles", () => {
    expect(
      activityTailLabel(
        [{ id: "posts", name: "get_top_from_batch", ok: true }],
        null,
      ),
    ).toBeNull();
  });

  test("moves to the honest persistence phase once the draft has rendered", () => {
    expect(
      activityTailLabel(
        [
          { id: "voice", name: "get_voice", ok: true },
          { id: "posts", name: "get_top_from_batch", ok: true },
        ],
        "Working",
        true,
      ),
    ).toBe("Saving your draft");
  });
});

describe("visibleActivityTools — post-render cleanup", () => {
  test("hides internal render/cite work but keeps real user-visible activity", () => {
    const tools = [
      { id: "voice", name: "get_voice", ok: true },
      { id: "render", name: "render_post", ok: true },
      { id: "cite", name: "render_cite", ok: undefined },
      { id: "image", name: "generate_lead_magnet_image", ok: undefined },
    ];
    expect(visibleActivityTools(tools, true).map((tool) => tool.name)).toEqual([
      "get_voice",
      "generate_lead_magnet_image",
    ]);
  });
});

describe("planProgressTitle — continuous checklist feedback", () => {
  const donePlan = [
    { id: "a", label: "Research", status: "done" as const },
    { id: "b", label: "Draft", status: "done" as const },
  ];

  test("keeps showing live work after every listed step is done", () => {
    expect(planProgressTitle(donePlan, "Working")).toBe("Working");
  });

  test("only reports plan complete after the turn actually settles", () => {
    expect(planProgressTitle(donePlan, null)).toBe("Plan complete");
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
