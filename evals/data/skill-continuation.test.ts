import { describe, test, expect } from "vitest";
import { selectSkillsWithContinuation } from "@/lib/agent/skills/index";
import { recentUserText, latestUserText } from "@/lib/agent/run";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// Reported bug: "newsjack" (no topic) → agent asks which story → user replies
// with just the topic ("llm war, gpt new models, meta launching their own") —
// a plain topic with ZERO newsjacking trigger words. Plain selectSkills on
// that reply alone selects nothing, so the skill's mandatory
// "call search_news before drafting" instruction never re-fires and the model
// wrote from stale training-data memory instead of grounding in the topic.
//
// Fix: selectSkillsWithContinuation looks one user turn further back, and if
// THAT turn selected a specialized skill (newsjack/brandjack/namejack/
// lead-magnet), carries it forward.
// ---------------------------------------------------------------------------

function userMsg(text: string): ChatMessage {
  return { role: "user", content: text };
}
function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", content: text };
}

describe("recentUserText", () => {
  test("concatenates the last TWO user turns, most recent last", () => {
    const history: ChatMessage[] = [
      userMsg("newsjack"),
      assistantMsg("Which story would you like to newsjack?"),
      userMsg("the llm war, gpt and meta launching new models"),
    ];
    expect(recentUserText(history)).toBe(
      "newsjack the llm war, gpt and meta launching new models",
    );
    // latestUserText, unchanged, still returns ONLY the newest turn.
    expect(latestUserText(history)).toBe("the llm war, gpt and meta launching new models");
  });

  test("only one user turn exists → returns just that one", () => {
    const history: ChatMessage[] = [userMsg("hello")];
    expect(recentUserText(history)).toBe("hello");
  });

  test("no user turns → empty string", () => {
    expect(recentUserText([assistantMsg("hi")])).toBe("");
  });

  test("content-block messages are flattened to their text parts", () => {
    const history: ChatMessage[] = [
      userMsg("newsjack"),
      assistantMsg("Which story?"),
      {
        role: "user",
        content: [
          { type: "text", text: "the llm war" },
          { type: "text", text: " topic" },
        ],
      } as ChatMessage,
    ];
    expect(recentUserText(history)).toBe("newsjack the llm war  topic");
  });
});

describe("selectSkillsWithContinuation — the reported scenario", () => {
  test("a topic-only follow-up after 'newsjack' still selects newsjacking", () => {
    const latest = "the llm war, gpt and meta launching new models";
    const recent = "newsjack " + latest;
    const ids = selectSkillsWithContinuation(latest, recent).map((s) => s.id);
    expect(ids).toContain("newsjacking");
  });

  test("brandjack continuation works the same way", () => {
    const latest = "notion, they just raised a huge round";
    const recent = "brandjack " + latest;
    const ids = selectSkillsWithContinuation(latest, recent).map((s) => s.id);
    expect(ids).toContain("brandjacking");
  });

  test("namejack continuation works the same way", () => {
    const latest = "sam altman's latest post about scaling teams";
    const recent = "namejack " + latest;
    const ids = selectSkillsWithContinuation(latest, recent).map((s) => s.id);
    expect(ids).toContain("namejacking");
  });

  test("does NOT trigger when the latest turn already resolves a DIFFERENT specialized skill", () => {
    // The latest turn explicitly asks for a lead magnet — that must win, not
    // get overridden by an older newsjack mention.
    const latest = "actually give me a lead magnet giveaway post instead";
    const recent = "newsjack " + latest;
    const skills = selectSkillsWithContinuation(latest, recent);
    const ids = skills.map((s) => s.id);
    expect(ids).toContain("lead-magnet");
    // The carried-forward newsjacking skill must not also sneak in and push
    // lead-magnet out — lead-magnet is what the user is NOW asking for.
    expect(ids[0]).toBe("lead-magnet");
  });

  test("no specialized skill in EITHER window → selects nothing extra (matches plain selectSkills)", () => {
    const latest = "make the hook punchier";
    const recent = "can you tighten this up? " + latest;
    const ids = selectSkillsWithContinuation(latest, recent).map((s) => s.id);
    expect(ids).not.toContain("newsjacking");
    expect(ids).not.toContain("brandjacking");
    expect(ids).not.toContain("namejacking");
    expect(ids).not.toContain("lead-magnet");
  });

  test("latest turn alone already selects a specialized skill → recent window is not consulted", () => {
    // Same-turn explicit request; behavior must be identical to plain
    // selectSkills (no double-counting, no reordering surprise).
    const latest = "newsjack the fed's rate decision";
    const ids = selectSkillsWithContinuation(latest, "irrelevant prior turn").map((s) => s.id);
    expect(ids[0]).toBe("newsjacking");
  });

  test("respects the cap (max 3) even after carrying a skill forward", () => {
    const latest = "hook it up, sound like me, rewrite this in my voice";
    const recent = "newsjack " + latest;
    const skills = selectSkillsWithContinuation(latest, recent, 3);
    expect(skills.length).toBeLessThanOrEqual(3);
    expect(skills.map((s) => s.id)).toContain("newsjacking");
  });
});
