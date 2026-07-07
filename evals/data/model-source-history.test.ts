import { describe, expect, test } from "vitest";
import {
  chatHistoryWithModelSources,
  customSkillsToolCall,
  extractLeadMagnetSelection,
  extractModelSourceId,
  leadMagnetToolCall,
  latestLeadMagnetSelection,
  modelSourceEnvelope,
  modelSourceToolCall,
  postFormatToolCall,
  shouldApplyLeadMagnetContext,
  tagArtifactWithLeadMagnet,
  tagArtifactWithNoModelFormat,
} from "@/app/api/chats/[id]/stream/route";
import type { ToolCall } from "@/lib/openrouter";

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
    expect(history[2].content).toBe("Use the 30+ posts / 1,000+ comments stat.");
  });

  test("model-source marker can coexist with custom-skill marker", () => {
    const sourceId = "22222222-2222-2222-2222-222222222222";
    const calls = [modelSourceToolCall(sourceId), customSkillsToolCall(["cta"])];

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
    });

    expect(call.function.name).toBe("_lead_magnet_selected");
    expect(JSON.parse(call.function.arguments)).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      title: "Hook Audit Checklist",
      selection: "manual",
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

  test("lead-magnet source posts auto-apply lead magnet mode for modeled post prompts", () => {
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

  test("selected lead magnet applies to broad post-writing prompts", () => {
    expect(
      shouldApplyLeadMagnetContext({
        userText: "Write a post about my onboarding checklist.",
        hasModelSource: false,
        noModelFormatId: null,
        hasSelectedLeadMagnet: true,
      }),
    ).toBe(true);
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
    expect(tagArtifactWithLeadMagnet(cite, leadMagnet)).toBe(cite);
  });
});
