import { describe, expect, test } from "vitest";
import {
  applyCiteSourceToDraftArtifacts,
  chatHistoryWithModelSources,
  customSkillsToolCall,
  extractLeadMagnetSelection,
  extractModelSourceId,
  firstSourceImage,
  leadMagnetToolCall,
  latestLeadMagnetSelection,
  modelSourceEnvelope,
  modelSourceToolCall,
  postFormatToolCall,
  reusableManualLeadMagnetIdForTurn,
  shouldApplyLeadMagnetContext,
  sourceReferenceFromCiteArtifact,
  sourceMediaCanRenderAsImage,
  tagArtifactWithLeadMagnet,
  tagArtifactWithModelSourceReference,
  tagArtifactWithNoModelFormat,
  withLeadMagnetImagePlanStep,
  withLeadMagnetResourcePlanStep,
} from "@/lib/agent/chat-turn";
import type { ToolCall } from "@/lib/openrouter";
import { artifactLeadMagnet } from "@/lib/chat-artifact-policy";

type DbRow = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
};

describe("model-source history", () => {
  test("template sources are restored into future model history", () => {
    const marker = modelSourceToolCall("11111111-1111-1111-1111-111111111111");
    const rows: DbRow[] = [
      {
        role: "user",
        content: "Use this template for a post about AI-assisted client wins.",
        tool_calls: [marker],
        tool_call_id: null,
      },
      {
        role: "assistant",
        content: "Which client stat should I use?",
        tool_calls: null,
        tool_call_id: null,
      },
      {
        role: "user",
        content: "Use the 30+ posts / 1,000+ comments stat.",
        tool_calls: null,
        tool_call_id: null,
      },
    ];
    const sources = new Map([
      [
        "11111111-1111-1111-1111-111111111111",
        {
          id: "11111111-1111-1111-1111-111111111111",
          source: "template",
          post_text: "I helped {client} get {result} without {pain}.",
        },
      ],
    ]);

    const history = chatHistoryWithModelSources(rows, sources);
    const first = history[0];

    expect(Array.isArray(first.content)).toBe(true);
    expect(JSON.stringify(first.content)).toContain("--- TEMPLATE TO FILL ---");
    expect(JSON.stringify(first.content)).toContain(
      "I helped {client} get {result} without {pain}.",
    );
    expect(history[2].content).toBe(
      "Use the 30+ posts / 1,000+ comments stat.",
    );
  });

  test("model-source marker can coexist with custom-skill marker", () => {
    const sourceId = "22222222-2222-2222-2222-222222222222";
    const calls = [
      modelSourceToolCall(sourceId),
      customSkillsToolCall(["cta"]),
    ];

    expect(extractModelSourceId(calls)).toBe(sourceId);
    expect(calls.map((c) => c.function.name)).toEqual([
      "_model_source_attached",
      "_custom_skills_applied",
    ]);
  });

  test("model source envelopes keep provenance-specific markers", () => {
    expect(
      modelSourceEnvelope({ source: "template", post_text: "Template body" }),
    ).toContain("--- TEMPLATE TO FILL ---");
    expect(
      modelSourceEnvelope({ source: "draft", post_text: "Draft body" }),
    ).toContain("--- POST TO REFINE ---");
    expect(
      modelSourceEnvelope({ source: "swipe", post_text: "Swipe body" }),
    ).toContain("--- POST TO MODEL AFTER ---");
  });

  test("model source envelopes keep source URLs out of prompt text", () => {
    const envelope = modelSourceEnvelope({
      source: "swipe",
      post_text: "Swipe body",
      source_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
    });

    expect(envelope).not.toContain("Original post URL:");
    expect(envelope).not.toContain(
      "https://www.linkedin.com/feed/update/urn:li:activity:1/",
    );
  });

  test("model source reference stamps generated draft metadata", () => {
    const tagged = tagArtifactWithModelSourceReference(
      {
        id: "artifact-1",
        kind: "post",
        title: "Draft",
        body: "Body",
        meta: { lead_magnet: { id: "lm", title: "LM" } },
      },
      {
        source_post_id: "post-1",
        source_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      },
    );

    expect(tagged.meta).toMatchObject({
      source: "model_source",
      source_post_id: "post-1",
      source_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      lead_magnet: { id: "lm", title: "LM" },
    });
  });

  test("model source reference preserves verified source identity without a public URL", () => {
    const tagged = tagArtifactWithModelSourceReference(
      {
        id: "artifact-1",
        kind: "post",
        title: "Draft",
        body: "Body",
      },
      { source_post_id: "private-source-1", source_url: null },
    );

    expect(tagged.meta).toEqual({
      source: "model_source",
      source_post_id: "private-source-1",
    });
  });

  test("model source reference does not stamp cite artifacts", () => {
    const tagged = tagArtifactWithModelSourceReference(
      {
        id: "cite-1",
        kind: "cite",
        title: "Source",
        body: "Source",
        meta: {},
      },
      {
        source_post_id: "post-1",
        source_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      },
    );

    expect(tagged.meta).toEqual({});
  });

  test("cite artifacts can provide a draft source reference", () => {
    expect(
      sourceReferenceFromCiteArtifact({
        id: "cite-1",
        kind: "cite",
        title: "Source",
        body: "",
        meta: {
          postId: "post-from-meta",
          card: {
            id: "post-from-card",
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
          },
        },
      }),
    ).toEqual({
      source_post_id: "post-from-card",
      source_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
    });
  });

  test("cite artifacts can provide a source image lookup key without a URL", () => {
    expect(
      sourceReferenceFromCiteArtifact({
        id: "cite-1",
        kind: "cite",
        title: "Source",
        body: "",
        meta: {
          card: {
            id: "post-from-card",
          },
        },
      }),
    ).toEqual({
      source_post_id: "post-from-card",
      source_url: null,
    });
  });

  test("cite source metadata can move onto an already-rendered draft", () => {
    const artifacts = [
      {
        id: "draft-1",
        kind: "post" as const,
        title: "Draft",
        body: "A modeled draft.",
        meta: {},
      },
    ];

    const updated = applyCiteSourceToDraftArtifacts(artifacts, [
      {
        id: "cite-1",
        kind: "cite",
        title: "Source",
        body: "",
        meta: {
          card: {
            id: "source-post-1",
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
          },
        },
      },
    ]);

    // Returns the UPDATED artifact(s), not just a boolean — the caller
    // re-sends exactly these over the live SSE stream so the browser (which
    // already rendered the draft with no chip) picks up the correction.
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe("draft-1");
    expect(artifacts[0].meta).toMatchObject({
      source: "model_source",
      source_post_id: "source-post-1",
      source_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
    });
  });

  test("a draft that ALREADY has a source_url is skipped (not overwritten, not re-sent)", () => {
    const artifacts = [
      {
        id: "draft-1",
        kind: "post" as const,
        title: "Draft",
        body: "A modeled draft.",
        meta: { source_url: "https://existing.example/already-tagged" },
      },
    ];
    const updated = applyCiteSourceToDraftArtifacts(artifacts, [
      {
        id: "cite-1",
        kind: "cite",
        title: "Source",
        body: "",
        meta: {
          card: {
            id: "source-post-2",
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:2/",
          },
        },
      },
    ]);
    expect(updated).toHaveLength(0);
    expect(artifacts[0].meta.source_url).toBe(
      "https://existing.example/already-tagged",
    );
  });

  test("a later cite cannot overwrite an attached source identity that has no URL", () => {
    const artifacts = [
      {
        id: "draft-1",
        kind: "post" as const,
        title: "Draft",
        body: "A modeled draft.",
        meta: {
          source: "model_source",
          source_post_id: "attached-private-source",
        },
      },
    ];

    const updated = applyCiteSourceToDraftArtifacts(artifacts, [
      {
        id: "cite-1",
        kind: "cite",
        title: "Different source",
        body: "",
        meta: {
          card: {
            id: "different-source",
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:2/",
          },
        },
      },
    ]);

    expect(updated).toEqual([]);
    expect(artifacts[0].meta).toEqual({
      source: "model_source",
      source_post_id: "attached-private-source",
    });
  });

  test("a later cite for the same source can enrich its missing URL", () => {
    const artifacts = [
      {
        id: "draft-1",
        kind: "post" as const,
        title: "Draft",
        body: "A modeled draft.",
        meta: { source: "model_source", source_post_id: "source-1" },
      },
    ];

    const updated = applyCiteSourceToDraftArtifacts(artifacts, [
      {
        id: "cite-1",
        kind: "cite",
        title: "Same source",
        body: "",
        meta: {
          card: {
            id: "source-1",
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
          },
        },
      },
    ]);

    expect(updated).toHaveLength(1);
    expect(artifacts[0].meta).toMatchObject({
      source_post_id: "source-1",
      source_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
    });
  });

  test("multiple drafts pending in the same turn all get backfilled and returned for re-send", () => {
    const artifacts = [
      {
        id: "draft-1",
        kind: "post" as const,
        title: "Draft 1",
        body: "First.",
        meta: {},
      },
      {
        id: "draft-2",
        kind: "hook" as const,
        title: "Draft 2",
        body: "Second.",
        meta: {},
      },
    ];
    const updated = applyCiteSourceToDraftArtifacts(artifacts, [
      {
        id: "cite-1",
        kind: "cite",
        title: "Source",
        body: "",
        meta: {
          card: {
            id: "source-post-3",
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:3/",
          },
        },
      },
    ]);
    expect(updated.map((a) => a.id)).toEqual(["draft-1", "draft-2"]);
    expect(
      artifacts.every((a) => (a.meta as { source_url?: string }).source_url),
    ).toBe(true);
  });

  test("no cite artifacts → nothing changes, empty return", () => {
    const artifacts = [
      {
        id: "draft-1",
        kind: "post" as const,
        title: "Draft",
        body: "A draft.",
        meta: {},
      },
    ];
    expect(applyCiteSourceToDraftArtifacts(artifacts, [])).toEqual([]);
    expect(artifacts[0].meta).toEqual({});
  });

  test("source image resolver accepts only true image posts", () => {
    expect(sourceMediaCanRenderAsImage("image")).toBe(true);
    expect(sourceMediaCanRenderAsImage("document")).toBe(false);
    expect(sourceMediaCanRenderAsImage("video")).toBe(false);
    expect(
      firstSourceImage({
        id: "post-1",
        media_type: "image",
        media_urls: ["https://media.example.com/image.jpg"],
      }),
    ).toEqual({
      postId: "post-1",
      mediaType: "image",
      imageUrl: "https://media.example.com/image.jpg",
    });
    expect(
      firstSourceImage({
        id: "post-2",
        media_type: "document",
        media_urls: ["https://media.example.com/cover-page.jpg"],
      }),
    ).toBeNull();
  });

  test("server image generation step is appended to the active checklist", () => {
    const initial = [
      {
        id: "voice",
        label: "Read your voice profile",
        status: "done" as const,
      },
      {
        id: "draft",
        label: "Draft the lead-magnet post",
        status: "active" as const,
      },
    ];

    const active = withLeadMagnetImagePlanStep(initial, "active");
    expect(active).toEqual([
      ...initial,
      {
        id: "server_lead_magnet_image",
        label: "Adapt the source image",
        status: "active",
      },
    ]);

    const done = withLeadMagnetImagePlanStep(active, "done");
    expect(done.at(-1)).toEqual({
      id: "server_lead_magnet_image",
      label: "Adapt the source image",
      status: "done",
    });
    expect(done).toHaveLength(3);
  });

  test("server image generation step creates a minimal checklist when no plan exists", () => {
    expect(withLeadMagnetImagePlanStep([], "active")).toEqual([
      {
        id: "server_draft_lead_magnet_post",
        label: "Draft the lead-magnet post",
        status: "done",
      },
      {
        id: "server_lead_magnet_image",
        label: "Adapt the source image",
        status: "active",
      },
    ]);
  });

  test("server lead magnet resource step runs after the draft checklist item", () => {
    const active = withLeadMagnetResourcePlanStep([], "active");
    expect(active).toEqual([
      {
        id: "server_draft_lead_magnet_post",
        label: "Draft the lead-magnet post",
        status: "done",
      },
      {
        id: "server_lead_magnet_resource",
        label: "Generate or match the lead magnet resource",
        status: "active",
      },
    ]);

    expect(withLeadMagnetResourcePlanStep(active, "done").at(-1)).toEqual({
      id: "server_lead_magnet_resource",
      label: "Generate or match the lead magnet resource",
      status: "done",
    });
  });

  test("post-format marker persists the forced no-model format", () => {
    const call = postFormatToolCall({
      id: "contrarian_take",
      label: "Contrarian Take",
      forced: true,
    });

    expect(call.function.name).toBe("_post_format_selected");
    expect(JSON.parse(call.function.arguments)).toEqual({
      id: "contrarian_take",
      label: "Contrarian Take",
      forced: true,
    });
  });

  test("lead-magnet marker persists the selected resource", () => {
    const call = leadMagnetToolCall({
      id: "33333333-3333-3333-3333-333333333333",
      title: "Hook Audit Checklist",
      selection: "manual",
      publicSlug: "hook-audit-checklist-abcd1234",
      selectionSummary: "A checklist for scoring and revising LinkedIn hooks.",
      deliverables: ["Hook scorecard", "Revision checklist"],
      resourceType: "scorecard",
      estimatedMinutes: 10,
    });

    expect(call.function.name).toBe("_lead_magnet_selected");
    expect(JSON.parse(call.function.arguments)).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      title: "Hook Audit Checklist",
      selection: "manual",
      publicSlug: "hook-audit-checklist-abcd1234",
      selectionSummary: "A checklist for scoring and revising LinkedIn hooks.",
      deliverables: ["Hook scorecard", "Revision checklist"],
      resourceType: "scorecard",
      estimatedMinutes: 10,
    });
  });

  test("lead-magnet marker can be recovered for follow-up turns", () => {
    const first = leadMagnetToolCall({
      id: "33333333-3333-3333-3333-333333333333",
      title: "Hook Audit Checklist",
      selection: "manual",
    });
    const latest = leadMagnetToolCall({
      id: "44444444-4444-4444-4444-444444444444",
      title: "Cold DM Playbook",
      selection: "auto",
    });

    expect(extractLeadMagnetSelection([first])).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      title: "Hook Audit Checklist",
      selection: "manual",
    });
    expect(
      latestLeadMagnetSelection([
        {
          role: "user",
          content: "Write a lead magnet post",
          tool_calls: [first],
          tool_call_id: null,
        },
        {
          role: "assistant",
          content: "Drafted.",
          tool_calls: null,
          tool_call_id: null,
        },
        {
          role: "user",
          content: "Make the CTA stronger",
          tool_calls: [latest],
          tool_call_id: null,
        },
      ]),
    ).toEqual({
      id: "44444444-4444-4444-4444-444444444444",
      title: "Cold DM Playbook",
      selection: "auto",
    });
  });

  test("previous auto lead magnet selections are not reused before the next draft exists", () => {
    expect(
      reusableManualLeadMagnetIdForTurn(null, {
        id: "44444444-4444-4444-4444-444444444444",
        selection: "auto",
      }),
    ).toBeNull();
    expect(
      reusableManualLeadMagnetIdForTurn(null, {
        id: "33333333-3333-3333-3333-333333333333",
        selection: "manual",
      }),
    ).toBe("33333333-3333-3333-3333-333333333333");
    expect(
      reusableManualLeadMagnetIdForTurn(
        "22222222-2222-2222-2222-222222222222",
        {
          id: "33333333-3333-3333-3333-333333333333",
          selection: "manual",
        },
      ),
    ).toBe("22222222-2222-2222-2222-222222222222");
  });

  test("selected lead magnet applies to search/adapt lead-magnet prompts", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText:
          "Find the most recent high-performing lead-magnet post in my swipe file and adapt it.",
        hasModelSource: false,
        noModelFormatId: null,
        hasSelectedLeadMagnet: true,
      }),
    ).toBe(true);
  });

  test("auto lead magnet selection applies to lead-magnet draft prompts", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText:
          "Find the most recent high-performing lead-magnet post in my swipe file and adapt it.",
        hasModelSource: false,
        noModelFormatId: null,
        hasSelectedLeadMagnet: false,
      }),
    ).toBe(true);
  });

  test("lead magnet selection applies to modeled lead-magnet post prompts", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Adapt this into a lead magnet post in my voice.",
        hasModelSource: true,
        modelSourcePostType: "regular",
        noModelFormatId: null,
        hasSelectedLeadMagnet: true,
      }),
    ).toBe(true);
  });

  test("an explicitly selected lead magnet applies to a broad modeled post request", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText:
          "Model an original post in my voice after the attached post. Keep its structure and hook style.",
        hasModelSource: true,
        modelSourcePostType: "regular",
        noModelFormatId: null,
        hasSelectedLeadMagnet: true,
      }),
    ).toBe(true);
  });

  test("a lead-magnet source preserves lead-magnet mode for a broad model request", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText:
          "Model an original post in my voice after the attached post. Keep its structure and hook style.",
        hasModelSource: true,
        modelSourcePostType: "lead_magnet",
        noModelFormatId: null,
        hasSelectedLeadMagnet: false,
      }),
    ).toBe(true);
  });

  test("a lead-magnet source DOES apply when the message asks for a giveaway post", () => {
    // Intent present ("lead magnet post") + source is a lead magnet → giveaway.
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Model this into a lead magnet post in my voice.",
        hasModelSource: true,
        modelSourcePostType: "lead_magnet",
        noModelFormatId: null,
        hasSelectedLeadMagnet: false,
      }),
    ).toBe(true);
  });

  test("lead magnet selection ignores explicitly regular modeled posts", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Adapt this into a regular post in my voice.",
        hasModelSource: true,
        modelSourcePostType: "lead_magnet",
        noModelFormatId: null,
        hasSelectedLeadMagnet: true,
      }),
    ).toBe(false);
  });

  test("auto lead magnet selection does not attach to pure search prompts", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Find lead magnet posts in my swipe file.",
        hasModelSource: false,
        noModelFormatId: null,
        hasSelectedLeadMagnet: false,
      }),
    ).toBe(false);
  });

  test("selected lead magnet applies when the topic itself is a giveaway asset", () => {
    // "checklist" is a lead-magnet intent word, so this reads as a giveaway
    // post even without the phrase "lead magnet" — the selected resource
    // legitimately applies.
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Write a post about my onboarding checklist.",
        hasModelSource: false,
        noModelFormatId: null,
        hasSelectedLeadMagnet: true,
      }),
    ).toBe(true);
  });

  test("THE MISUSE FIX: selected lead magnet does NOT hijack a neutral post request", () => {
    // The core bug: a leftover / accidental lead-magnet selection turned a
    // plain "write a post about X" (no giveaway intent) into a giveaway post.
    // Now the selection is a hint, not a trigger — a neutral topic stays a
    // regular post.
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Write a post about remote work productivity.",
        hasModelSource: false,
        noModelFormatId: null,
        hasSelectedLeadMagnet: true,
      }),
    ).toBe(false);
  });

  test("selected lead magnet is ignored for explicitly regular posts", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Write a regular post about founder-led sales.",
        hasModelSource: false,
        noModelFormatId: null,
        hasSelectedLeadMagnet: true,
      }),
    ).toBe(false);
  });

  test("lead-magnet no-model format keeps auto resource selection working", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Write about onboarding.",
        hasModelSource: false,
        noModelFormatId: "lead_magnet_resource_inventory",
        hasSelectedLeadMagnet: false,
      }),
    ).toBe(true);
  });

  test("post-format metadata tags generated artifacts but not cites", () => {
    const format = {
      id: "contrarian_take" as const,
      label: "Contrarian Take",
      forced: true,
    };
    const post = {
      id: "a1",
      kind: "post" as const,
      title: "Draft",
      body: "A post.",
      meta: { existing: true },
    };
    const cite = {
      id: "c1",
      kind: "cite" as const,
      title: "Source",
      body: "A cite.",
      meta: {},
    };

    expect(tagArtifactWithNoModelFormat(post, format).meta).toEqual({
      existing: true,
      no_model_format: format,
    });
    expect(tagArtifactWithNoModelFormat(cite, format)).toBe(cite);
  });

  test("lead-magnet metadata tags generated artifacts but not cites", () => {
    const leadMagnet = {
      id: "44444444-4444-4444-4444-444444444444",
      title: "Lead Magnet Library",
      selection: "auto" as const,
      publicSlug: "lead-magnet-library-abcd1234",
      selectionSummary: "A practical library of reusable lead magnet assets.",
      deliverables: ["Lead magnet scorecard", "Launch checklist"],
      resourceType: "swipe_file" as const,
      estimatedMinutes: 15,
    };
    const post = {
      id: "a1",
      kind: "post" as const,
      title: "Draft",
      body: "A post.",
      meta: { existing: true },
    };
    const cite = {
      id: "c1",
      kind: "cite" as const,
      title: "Source",
      body: "A cite.",
      meta: {},
    };

    expect(tagArtifactWithLeadMagnet(post, leadMagnet).meta).toEqual({
      existing: true,
      lead_magnet: leadMagnet,
    });
    expect(
      artifactLeadMagnet(tagArtifactWithLeadMagnet(post, leadMagnet)),
    ).toEqual(leadMagnet);
    expect(tagArtifactWithLeadMagnet(cite, leadMagnet)).toBe(cite);
  });
});

// ---------------------------------------------------------------------------
// isBatchArtifactFilingRow — regression for the "batch chat follow-up dumps
// raw <tool_call> XML" bug. The batch worker files each draft as an assistant
// row with content:"" + artifacts:[…] and NO tool_calls. When the model later
// answered a follow-up turn in that chat, it saw those content-less assistant
// rows in its history, interpreted the pattern as an invalid mid-turn state,
// and hallucinated raw tool-call XML in its next reply. The stream route now
// filters these rows out of the model history via isBatchArtifactFilingRow.
// ---------------------------------------------------------------------------
import { isBatchArtifactFilingRow } from "@/lib/agent/chat-turn";

describe("isBatchArtifactFilingRow — the batch content-less assistant filter", () => {
  test("flags a batch filing row: assistant + empty content + no tool_calls", () => {
    expect(
      isBatchArtifactFilingRow({
        role: "assistant",
        content: "",
        tool_calls: null,
        tool_call_id: null,
      }),
    ).toBe(true);
  });

  test("flags a whitespace-only content assistant row", () => {
    expect(
      isBatchArtifactFilingRow({
        role: "assistant",
        content: "   \n  ",
        tool_calls: null,
        tool_call_id: null,
      }),
    ).toBe(true);
  });

  test("does NOT flag a normal assistant reply with text", () => {
    expect(
      isBatchArtifactFilingRow({
        role: "assistant",
        content: "Here's a post about growth.",
        tool_calls: null,
        tool_call_id: null,
      }),
    ).toBe(false);
  });

  test("does NOT flag an assistant tool-calling turn (empty text but tool_calls present)", () => {
    // A real agent turn where the model called a tool: content is empty but
    // tool_calls IS set. Filtering these would break the model's ability to
    // see its own recent tool history.
    expect(
      isBatchArtifactFilingRow({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_voice", arguments: "{}" },
          },
        ],
        tool_call_id: null,
      }),
    ).toBe(false);
  });

  test("does NOT flag user or tool rows", () => {
    expect(
      isBatchArtifactFilingRow({
        role: "user",
        content: "",
        tool_calls: null,
        tool_call_id: null,
      }),
    ).toBe(false);
    expect(
      isBatchArtifactFilingRow({
        role: "tool",
        content: "",
        tool_calls: null,
        tool_call_id: "c1",
      }),
    ).toBe(false);
  });
});

describe("chatHistoryWithModelSources — filters batch filing rows", () => {
  test("a batch chat's 7 content-less assistant rows are DROPPED from model history", () => {
    // Realistic batch chat shape: opening asst message + 7 filing rows + closing.
    // The 7 filing rows all have content:"" and no tool_calls. Model history
    // must drop them so the model doesn't see an invalid pattern of empty
    // assistant turns and hallucinate <tool_call> XML on the next reply.
    const rows: DbRow[] = [
      {
        role: "assistant",
        content: "On it — building your week.",
        tool_calls: null,
        tool_call_id: null,
      },
      ...Array.from({ length: 7 }, () => ({
        role: "assistant" as const,
        content: "",
        tool_calls: null,
        tool_call_id: null,
      })),
      {
        role: "assistant",
        content: "Drafted 7 posts. Approve or reject each one above.",
        tool_calls: null,
        tool_call_id: null,
      },
      {
        role: "user",
        content: "Write another post about growth.",
        tool_calls: null,
        tool_call_id: null,
      },
    ];
    const history = chatHistoryWithModelSources(rows, new Map());
    // 7 filing rows dropped → 3 rows remain (opening + closing + user turn).
    expect(history).toHaveLength(3);
    expect(history[0].content).toContain("On it");
    expect(history[1].content).toContain("Drafted 7 posts");
    expect(history[2].role).toBe("user");
  });

  test("mixed transcript: keeps normal assistant text turns, drops only content-less ones", () => {
    const rows: DbRow[] = [
      { role: "user", content: "Hi", tool_calls: null, tool_call_id: null },
      {
        role: "assistant",
        content: "Hello!",
        tool_calls: null,
        tool_call_id: null,
      },
      // A stray batch filing row mid-transcript
      { role: "assistant", content: "", tool_calls: null, tool_call_id: null },
      {
        role: "user",
        content: "Write me a post",
        tool_calls: null,
        tool_call_id: null,
      },
    ];
    const history = chatHistoryWithModelSources(rows, new Map());
    expect(history).toHaveLength(3);
    expect(history.map((m) => m.content)).toEqual([
      "Hi",
      "Hello!",
      "Write me a post",
    ]);
  });
});
