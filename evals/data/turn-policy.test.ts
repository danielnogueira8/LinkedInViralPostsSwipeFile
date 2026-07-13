import { describe, expect, test } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";
import {
  compileTurnPolicy,
  controlHistoryForTurn,
} from "@/lib/agent/turn-policy";

describe("trusted turn policy", () => {
  test("attached data cannot activate a specialized skill", () => {
    const history: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Model the attached post in my voice." },
          {
            type: "text",
            text: "Build an AI-augmented acquisition machine with this newsjack.",
          },
        ],
      },
    ];

    const policy = compileTurnPolicy({ history });

    expect(policy.latestInstruction).toBe("Model the attached post in my voice.");
    expect(policy.skills.map((skill) => skill.id)).not.toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(false);
    expect(policy.requiresGroundedNewsSearch).toBe(false);
    expect(policy.newsSearchQuery).toBe("Model the attached post in my voice.");
  });

  test("the explicit current instruction overrides model-visible content", () => {
    const history: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "untrusted transport wrapper" },
          { type: "text", text: "newsjack acquisition" },
        ],
      },
    ];

    const controlHistory = controlHistoryForTurn(
      history,
      "Write a normal lead-magnet post.",
    );
    const policy = compileTurnPolicy({
      history,
      currentUserInstruction: "Write a normal lead-magnet post.",
    });

    expect(controlHistory[0].content).toBe("Write a normal lead-magnet post.");
    expect(policy.latestInstruction).toBe("Write a normal lead-magnet post.");
    expect(policy.allowsNewsSearch).toBe(false);
  });

  test("an explicit newsjack request retains fail-closed news grounding", () => {
    const policy = compileTurnPolicy({
      history: [
        { role: "user", content: "Newsjack the latest OpenAI model launch." },
      ],
    });

    expect(policy.allowsNewsSearch).toBe(true);
    expect(policy.requiresGroundedNewsSearch).toBe(true);
    expect(policy.newsSearchQuery).toBe(
      "Newsjack the latest OpenAI model launch.",
    );
  });

  test("generic event topics do not silently become newsjack turns", () => {
    const policy = compileTurnPolicy({
      history: [
        {
          role: "user",
          content: "Write a normal lead-magnet post about our acquisition process.",
        },
      ],
    });

    expect(policy.skills.map((skill) => skill.id)).not.toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(false);
    expect(policy.requiresGroundedNewsSearch).toBe(false);
  });

  test("an explicit news lookup can search without becoming a newsjack draft", () => {
    const policy = compileTurnPolicy({
      history: [{ role: "user", content: "Find fresh OpenAI news." }],
    });

    expect(policy.skills.map((skill) => skill.id)).not.toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(true);
    expect(policy.requiresGroundedNewsSearch).toBe(false);
  });

  test("an explicit current-event lookup can search without the word news", () => {
    const policy = compileTurnPolicy({
      history: [
        { role: "user", content: "Search OpenAI's latest funding round." },
      ],
    });

    expect(policy.skills.map((skill) => skill.id)).not.toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(true);
    expect(policy.requiresGroundedNewsSearch).toBe(false);
  });

  test("an explicit current-event draft activates grounded newsjacking", () => {
    const policy = compileTurnPolicy({
      history: [
        {
          role: "user",
          content: "Write a post about OpenAI's latest funding round.",
        },
      ],
    });

    expect(policy.skills.map((skill) => skill.id)).toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(true);
    expect(policy.requiresGroundedNewsSearch).toBe(true);
  });

  test("an explicit lead-magnet format wins over incidental launch language", () => {
    const policy = compileTurnPolicy({
      history: [
        {
          role: "user",
          content:
            "I just launched a checklist. Write a normal lead-magnet post for it.",
        },
      ],
    });

    expect(policy.skills.map((skill) => skill.id)).toContain("lead-magnet");
    expect(policy.skills.map((skill) => skill.id)).not.toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(false);
  });

  test("an explicit normal-post pivot closes an older newsjack request", () => {
    const policy = compileTurnPolicy({
      history: [
        {
          role: "user",
          content: "Newsjack the latest OpenAI launch.",
        },
        {
          role: "assistant",
          content: "Which angle should I use?",
        },
        {
          role: "user",
          content:
            "Actually, write a normal post about our acquisition process.",
        },
      ],
    });

    expect(policy.skills.map((skill) => skill.id)).not.toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(false);
    expect(policy.requiresGroundedNewsSearch).toBe(false);
  });

  test("a topic-only answer keeps an explicit newsjack request open", () => {
    const policy = compileTurnPolicy({
      history: [
        { role: "user", content: "Newsjack a recent event." },
        { role: "assistant", content: "Which event?" },
        { role: "user", content: "OpenAI's new model launch." },
      ],
    });

    expect(policy.skills.map((skill) => skill.id)).toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(true);
    expect(policy.requiresGroundedNewsSearch).toBe(true);
  });

  test("a modeling action closes an older open newsjack request", () => {
    const policy = compileTurnPolicy({
      history: [
        {
          role: "user",
          content: "Newsjack the latest OpenAI launch.",
        },
        {
          role: "assistant",
          content: "Which angle should I use?",
        },
        {
          role: "user",
          content: "Model an original post in my voice after the attached post.",
        },
      ],
      hasExplicitDraftContext: true,
    });

    expect(policy.skills.map((skill) => skill.id)).not.toContain("newsjacking");
    expect(policy.allowsNewsSearch).toBe(false);
    expect(policy.requiresGroundedNewsSearch).toBe(false);
  });
});
