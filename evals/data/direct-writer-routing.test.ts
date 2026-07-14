import { describe, expect, test } from "vitest";
import {
  directWriterEnabledForWorkspace,
  isDirectRefineEligible,
  isDirectOriginalPostEligible,
} from "@/lib/agent/direct-writer-routing";

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
    ]) {
      expect(
        isDirectOriginalPostEligible({ ...BASE, userInstruction }),
      ).toBe(false);
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
    ]) {
      expect(isDirectRefineEligible({ ...REFINE, refineInstruction })).toBe(true);
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
    ]) {
      expect(isDirectRefineEligible({ ...REFINE, refineInstruction })).toBe(false);
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
    ]) {
      expect(isDirectRefineEligible({ ...REFINE, refineInstruction })).toBe(false);
    }
  });
});
