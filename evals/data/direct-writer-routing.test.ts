import { describe, expect, test } from "vitest";
import {
  directWriterEnabledForWorkspace,
  isDirectFixedSourcePostEligible,
  isDirectMultiPostEligible,
  isDirectPartialTextEligible,
  isDirectRefineEligible,
  isDirectOriginalPostEligible,
} from "@/lib/agent/direct-writer-routing";
import { POST_INTENTS } from "@/lib/post-intents";

const BASE = {
  userInstruction:
    "Write an original post in my voice about why a personal brand is career leverage.",
  enabled: true,
  hasModelSource: false,
  isRefine: false,
  hasAttachments: false,
  hasLeadMagnet: false,
  hasCreatorStyle: false,
  voiceResolved: true,
};

describe("direct writer rollout", () => {
  test("requires the global flag and an explicit workspace allowlist entry", () => {
    expect(
      directWriterEnabledForWorkspace("ws-1", {
        COWORK_DIRECT_WRITER_ENABLED: "1",
        COWORK_DIRECT_WRITER_WORKSPACES: "ws-1, ws-2",
      }),
    ).toBe(true);
    expect(
      directWriterEnabledForWorkspace("ws-3", {
        COWORK_DIRECT_WRITER_ENABLED: "1",
        COWORK_DIRECT_WRITER_WORKSPACES: "ws-1, ws-2",
      }),
    ).toBe(false);
    expect(
      directWriterEnabledForWorkspace("ws-1", {
        COWORK_DIRECT_WRITER_ENABLED: "0",
        COWORK_DIRECT_WRITER_WORKSPACES: "*",
      }),
    ).toBe(false);
  });

  test("supports an immediate global and per-workspace kill switch", () => {
    expect(
      directWriterEnabledForWorkspace("ws-1", {
        COWORK_DIRECT_WRITER_ENABLED: "1",
        COWORK_DIRECT_WRITER_WORKSPACES: "*",
        COWORK_DIRECT_WRITER_KILL_SWITCH: "1",
      }),
    ).toBe(false);
    expect(
      directWriterEnabledForWorkspace("ws-1", {
        COWORK_DIRECT_WRITER_ENABLED: "1",
        COWORK_DIRECT_WRITER_WORKSPACES: "*",
        COWORK_DIRECT_WRITER_DISABLED_WORKSPACES: "ws-1",
      }),
    ).toBe(false);
  });

  test("uses the shared percentage and global rollout policy", () => {
    expect(
      directWriterEnabledForWorkspace("ws-sampled", {
        COWORK_V2_ENABLED: "1",
        COWORK_V2_ROLLOUT_MODE: "sample",
        COWORK_V2_ROLLOUT_PERCENT: "100",
      }),
    ).toBe(true);
    expect(
      directWriterEnabledForWorkspace("ws-global-killed", {
        COWORK_V2_ENABLED: "1",
        COWORK_V2_ROLLOUT_MODE: "global",
        COWORK_V2_KILL_SWITCH: "1",
      }),
    ).toBe(false);
  });
});

describe("direct original-post eligibility", () => {
  test("accepts a self-contained original post and an explicit no-search post", () => {
    expect(isDirectOriginalPostEligible(BASE)).toBe(true);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction:
          "Write a post about pricing discipline. Do not search or use sources.",
      }),
    ).toBe(true);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction:
          "Write a post about pricing. Exactly 800 characters. Do not search.",
      }),
    ).toBe(true);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction:
          "Write an original post in my voice about how building a personal brand is the biggest leverage you can build for your career. Choose a proven framework that fits the topic, but do not model it after one specific source post.",
      }),
    ).toBe(true);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction:
          "Write an original post about pricing, but do not model it after a source post.",
      }),
    ).toBe(true);
  });

  test("resumes a self-contained clarification answer as an original post", () => {
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction:
          "Help me write a LinkedIn post.\n\nClarification answer: Why public proof compounds into career leverage",
      }),
    ).toBe(true);
  });

  test.each([
    ["rollout disabled", { enabled: false }],
    ["attached source", { hasModelSource: true }],
    ["refine", { isRefine: true }],
    ["attachment", { hasAttachments: true }],
    ["lead magnet", { hasLeadMagnet: true }],
    ["creator style", { hasCreatorStyle: true }],
    ["voice preload failed", { voiceResolved: false }],
  ])("keeps %s on the hardened baseline", (_label, override) => {
    expect(isDirectOriginalPostEligible({ ...BASE, ...override })).toBe(false);
  });

  test("keeps research, actions, ambiguous briefs, and multi-post requests off the lane", () => {
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction:
          "Search the latest viral posts and write a post modeled after the best one.",
      }),
    ).toBe(false);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction: "Write a newsjack post about today's breaking news.",
      }),
    ).toBe(false);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction: "Write a post and schedule it for tomorrow.",
      }),
    ).toBe(false);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction: "Write a post.",
      }),
    ).toBe(false);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction: "Write exactly two posts about founder-led sales.",
      }),
    ).toBe(false);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction:
          "Write a post about founder-led sales, plus another variation for consultants.",
      }),
    ).toBe(false);
    expect(
      isDirectOriginalPostEligible({
        ...BASE,
        userInstruction:
          "Write a post about that. Do not search or use sources.",
      }),
    ).toBe(false);
    for (const userInstruction of [
      "Write a hook for a LinkedIn post about pricing. Do not search.",
      "Give me the opening line for a LinkedIn post about pricing. Do not search.",
      "Write a post explaining it. Do not search.",
      "Write a post about the idea. Do not search.",
      "Write a post about my idea. Do not search.",
      "Write a post about the point above. Do not search.",
      "Research the latest LinkedIn trends and write a post about founder-led sales.",
      "Research B2B pricing strategies and write a post about pricing discipline.",
      "Research personal branding, then write a post about why it matters.",
      "Investigate how founder-led sales teams price services, then write a post about pricing discipline.",
      "Write a post about pricing and plan it for Friday.",
      "Write a post about pricing and queue it for Friday.",
      "Write a post about pricing and queue it.",
      "Write a post about pricing and put it on the calendar.",
      "Write a post about pricing and set it to ready.",
      "Write a post about pricing plus a content calendar. Do not search.",
      "Write a post expanding on my last message. Do not search.",
      "Write a post continuing our conversation. Do not use sources.",
      "Write a post about my last message. Do not search.",
      "Write a post based on my earlier point. Do not search.",
      "Write a post from our discussion about pricing. Do not search.",
      "Write a post about the idea from our conversation. Do not search.",
      "Write a post inspired by our chat. Do not search.",
      "Write a post based on our conversation about pricing. Do not search.",
      "Write a post about the topic we covered yesterday. Do not search.",
      "Write a post from our call about founder-led sales. Do not search.",
      "Explain why pricing discipline works, then write a post about it. Do not search.",
      "Write a post about pricing, then summarize the strategy. Do not search.",
      "Do not write a post about pricing. Do not search.",
      "I do not want you to write a post about pricing. Do not search.",
      "Why does the prompt write a post about pricing fail?",
      "Can you explain how to write a post about pricing?",
      "Is write a post about pricing a good prompt?",
      "Should I write a post about pricing?",
      "Do you think I should write a post about pricing?",
      "Would you recommend I write a post about pricing?",
      "Can I write a post about pricing?",
      "Could I write a post about pricing?",
      "Would you write a post about pricing?",
      "Should you write a post about pricing?",
      "Is it worth it to write a post about pricing?",
      "Tell me whether I should write a post about pricing.",
      "Help me decide if I should write a post about pricing.",
      "Write a post about pricing then create a reminder. Do not search.",
      "Write a post about pricing and put it in drafts. Do not search.",
      "Write a post about pricing with an image. Do not search.",
      "Write a post with a graphic about pricing. Do not search.",
      "Create a post and accompanying visual about pricing. Do not search.",
      "Write a post about pricing including a visual. Do not search.",
      "What should I include when I write a post about pricing?",
      "Search my swipe file for a source and write a post about pricing. Do not browse.",
      "Write a post about pricing and send it to Daniel. Do not search.",
      "Write a post about pricing, then email it to me. Do not search.",
      "Write a post about pricing and add it to my board. Do not search.",
      "Use my saved posts to write a post about pricing. Do not search the web.",
      "Look through my prior drafts and write a post about pricing. Do not browse.",
      "Search my past drafts for data and write a post about pricing. Do not browse.",
      "Use my workspace context to write a post about pricing. Do not search.",
      "Use my bookmarks to write a post about pricing. Do not browse.",
      "Use the posts I saved to write an original post about pricing. Do not search the web.",
      "Use posts from my swipe file to write an original post about pricing. Do not browse the web.",
      "Use my examples to write an original post about pricing. Do not search.",
      "Use my content library to write an original post about pricing. Do not search.",
      "Write an original post about pricing based on my saved content. Do not search.",
    ]) {
      expect(isDirectOriginalPostEligible({ ...BASE, userInstruction })).toBe(
        false,
      );
    }
  });
});

describe("direct refine eligibility", () => {
  const REFINE = {
    enabled: true,
    isRefine: true,
    refineInstruction: "Make it shorter and keep the core argument.",
    targetResolved: true,
    targetKind: "post" as const,
    targetHasLeadMagnet: false,
    hasModelSource: false,
    hasAttachments: false,
    hasLeadMagnet: false,
    hasCreatorStyle: false,
    voiceResolved: true,
  };

  test("accepts self-contained hook, shorten, CTA, and general refinements", () => {
    for (const refineInstruction of [
      "Tighten the hook.",
      "Make it 20% shorter.",
      "Give it a stronger CTA.",
      "Make it more story-driven.",
      "Make it exactly 800 characters.",
      "Rewrite it to 800 characters.",
      "Keep it at 800 characters.",
    ]) {
      expect(isDirectRefineEligible({ ...REFINE, refineInstruction })).toBe(
        true,
      );
    }
  });

  test.each([
    ["rollout disabled", { enabled: false }],
    ["not marked refine", { isRefine: false }],
    ["unresolved target", { targetResolved: false }],
    ["hook-card target", { targetKind: "hook" as const }],
    ["target lead magnet", { targetHasLeadMagnet: true }],
    ["model source", { hasModelSource: true }],
    ["attachment", { hasAttachments: true }],
    ["selected lead magnet", { hasLeadMagnet: true }],
    ["creator style", { hasCreatorStyle: true }],
    ["missing voice", { voiceResolved: false }],
  ])("keeps %s on the baseline", (_label, override) => {
    expect(isDirectRefineEligible({ ...REFINE, ...override })).toBe(false);
  });

  test("keeps research, source discovery, actions, and multiple versions on the orchestrated path", () => {
    for (const refineInstruction of [
      "Research current trends and rewrite this.",
      "Find a source post and model this after it.",
      "Make it shorter and schedule it for tomorrow.",
      "Give me two different rewrites.",
      "Make it 0% shorter.",
      "Make it 100% shorter.",
      "Trim this by 0%.",
      "Reduce it by 100%.",
      "Shorten it by 0 percent.",
      "Trim this by 100 percent.",
      "Make it 70% shorter.",
      "Shorten it by 51%.",
      "Do not change this post.",
      "Do not make it shorter.",
      "I do not want you to rewrite it.",
      "Can you explain how to make this hook stronger?",
      "Tighten it and send it to Daniel.",
      "Should I make it shorter?",
      "Do you think I should tighten the hook?",
      "Can I make it more direct?",
      "Would a stronger CTA help?",
      "Tell me whether I should shorten it.",
      "Help me decide if I should rewrite the opening.",
      "Keep everything except the CTA.",
      "Do not include a CTA.",
      "No CTA.",
      "Without a CTA.",
      "Make it longer.",
      "Expand it.",
      "Add more detail.",
    ]) {
      expect(isDirectRefineEligible({ ...REFINE, refineInstruction })).toBe(
        false,
      );
    }
  });

  test("fails mixed-focus refinements closed instead of silently applying only one part", () => {
    for (const refineInstruction of [
      "Tighten the hook and strengthen the CTA.",
      "Shorten it and strengthen the CTA.",
      "Shorten the entire post and tighten the hook.",
      "Make it more story-driven and tighten the hook.",
      "Make it more direct and strengthen the CTA.",
      "Tighten the hook and add a personal anecdote.",
      "Strengthen the CTA and make the body more skimmable.",
      "Tighten the hook while adding a personal anecdote to the body.",
      "Tighten the hook and weave in an anecdote.",
      "Strengthen the CTA while making the body more skimmable.",
      "Tighten the hook. Tell a quick personal story in the middle.",
      "Tighten the hook, and don't forget to add a personal anecdote.",
      "Tighten the hook and keep adding personal anecdotes to the body.",
      "Tighten the hook and keep rewriting the middle.",
      "Tighten the hook & add a personal anecdote.",
      "Tighten the hook / rewrite the middle.",
      "Make it shorter and give me a content plan.",
    ]) {
      expect(isDirectRefineEligible({ ...REFINE, refineInstruction })).toBe(
        false,
      );
    }
  });
});

describe("direct source, partial, and multi eligibility", () => {
  const CONTEXT = {
    enabled: true,
    hasAttachments: false,
    hasLeadMagnet: false,
    hasCreatorStyle: false,
    voiceResolved: true,
    isRefine: false,
  };

  test("accepts one resolved fixed-source post without discovery", () => {
    expect(
      isDirectFixedSourcePostEligible({
        ...CONTEXT,
        userInstruction: "Model the attached source into one original post.",
        sourceResolved: true,
      }),
    ).toBe(true);
    expect(
      isDirectFixedSourcePostEligible({
        ...CONTEXT,
        userInstruction: POST_INTENTS.model.prompt,
        sourceResolved: true,
      }),
    ).toBe(true);
    expect(
      isDirectFixedSourcePostEligible({
        ...CONTEXT,
        userInstruction:
          "Model the attached source into one original post. Do not search for source posts.",
        sourceResolved: true,
      }),
    ).toBe(true);
  });

  test("fails unresolved, research, and action source turns closed", () => {
    for (const override of [
      { sourceResolved: false },
      { userInstruction: "Find another source and model it into a post." },
      { userInstruction: "Model this into a post and schedule it." },
      { userInstruction: "Don't rewrite this post; just analyze it." },
      {
        userInstruction:
          "Model the attached source into a post and include an analysis.",
      },
      {
        userInstruction:
          "Model the attached source into a post about the point we discussed earlier.",
      },
      {
        userInstruction:
          "I do not want you to write a post based on the attached source.",
      },
      {
        userInstruction:
          "Can you explain how to model the attached post into one variation?",
      },
      {
        userInstruction:
          "Search my swipe file for a source and write a post about pricing. Do not browse.",
      },
      { userInstruction: "Write a version of the CTA." },
      { userInstruction: "Draft one version of the headline." },
      { userInstruction: "Create a rewrite of the ending." },
      { userInstruction: "Model this into a post and send it to Daniel." },
    ]) {
      expect(
        isDirectFixedSourcePostEligible({
          ...CONTEXT,
          userInstruction: "Model the attached source into one original post.",
          sourceResolved: true,
          ...override,
        }),
      ).toBe(false);
    }
  });

  test("accepts self-contained and fixed-source partial text", () => {
    expect(
      isDirectPartialTextEligible({
        ...CONTEXT,
        userInstruction:
          "Give me exactly 3 hooks about distribution. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      }),
    ).toBe(true);
    expect(
      isDirectPartialTextEligible({
        ...CONTEXT,
        userInstruction: "Give me 3 hooks based on the attached source.",
        sourceRequested: true,
        sourceResolved: true,
      }),
    ).toBe(true);
    for (const userInstruction of [
      "Give me 3 hooks about pricing. Include a reason for each. Do not search.",
      "Give me 3 hooks about pricing, with the rationale beneath each. Do not search.",
    ]) {
      expect(
        isDirectPartialTextEligible({
          ...CONTEXT,
          userInstruction,
          sourceRequested: false,
          sourceResolved: false,
        }),
      ).toBe(true);
    }
  });

  test("keeps topic-less, mixed-kind, and unresolved partial turns on baseline", () => {
    for (const input of [
      {
        userInstruction: "Give me 3 hooks. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      },
      {
        userInstruction: "Give me 3 hooks and 3 titles. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      },
      {
        userInstruction: "Give me 3 hooks based on the attached source.",
        sourceRequested: true,
        sourceResolved: false,
      },
      {
        userInstruction:
          "Write one post and give me 3 hooks about pricing. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      },
      {
        userInstruction:
          "Explain why hooks matter, then give me 3 hooks about pricing. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      },
      {
        userInstruction:
          "Give me 3 hooks based on the attached source about the point we discussed earlier.",
        sourceRequested: true,
        sourceResolved: true,
      },
      {
        userInstruction:
          "Do not give me 3 hooks about pricing. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      },
      {
        userInstruction:
          "Can you explain how to give me 3 hooks about pricing?",
        sourceRequested: false,
        sourceResolved: false,
      },
      {
        userInstruction:
          "Give me 3 hooks about pricing, each under 80 characters. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      },
      {
        userInstruction:
          "Give me 3 hooks about pricing. Maximum 10 words each. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      },
      {
        userInstruction:
          "Give me 3 hooks about pricing, each exactly one sentence. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      },
    ]) {
      expect(isDirectPartialTextEligible({ ...CONTEXT, ...input })).toBe(false);
    }
  });

  test("accepts exact bounded original and fixed-source multi-post requests", () => {
    expect(
      isDirectMultiPostEligible({
        ...CONTEXT,
        userInstruction:
          "Write exactly two complete posts about pricing. Do not search.",
        sourceRequested: false,
        sourceResolved: false,
      }),
    ).toBe(true);
    expect(
      isDirectMultiPostEligible({
        ...CONTEXT,
        userInstruction: POST_INTENTS.variations.prompt,
        sourceRequested: true,
        sourceResolved: true,
      }),
    ).toBe(true);
    expect(
      isDirectFixedSourcePostEligible({
        ...CONTEXT,
        userInstruction: POST_INTENTS.variations.prompt,
        sourceResolved: true,
      }),
    ).toBe(false);
    expect(
      isDirectMultiPostEligible({
        ...CONTEXT,
        userInstruction: "Give me 3 variations of the attached post.",
        sourceRequested: true,
        sourceResolved: true,
      }),
    ).toBe(true);
  });

  test("keeps compound and unsafe multi-post requests on the baseline", () => {
    for (const userInstruction of [
      "Write exactly 2 posts and 3 hooks about pricing. Do not search.",
      "Write exactly 2 posts about pricing plus a content calendar. Do not search.",
      "Write exactly 2 posts about pricing and schedule them tomorrow.",
      "Write exactly 7 posts about pricing. Do not search.",
      "Write exactly 2 posts about pricing, then summarize the strategy. Do not search.",
      "Write exactly 2 posts based on the attached source about the point we discussed earlier.",
      "Please do not go ahead and write 3 posts about pricing. Do not search.",
      "What should I consider before I draft 3 posts about pricing?",
      "Write 3 posts about pricing and send them to Daniel. Do not search.",
      "Write 3 posts about pricing and compare them. Do not search.",
      "Draft 2 posts about pricing and rank them. Do not search.",
      "Give me 3 versions of the opening line.",
      "Give me 3 versions of the CTA.",
      "Give me 3 variations of the ending.",
      "Give me 3 rewrites of the first paragraph.",
      "Give me 3 versions of the headline.",
      "Give me 3 variations of the first sentence.",
    ]) {
      expect(
        isDirectMultiPostEligible({
          ...CONTEXT,
          userInstruction,
          sourceRequested: false,
          sourceResolved: false,
        }),
      ).toBe(false);
    }
  });
});
