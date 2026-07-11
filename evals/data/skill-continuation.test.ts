import { describe, test, expect } from "vitest";
import { selectSkillsWithContinuation, SKILLS } from "@/lib/agent/skills/index";
import { findOpenSpecializedSkill, latestUserText } from "@/lib/agent/run";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// Reported bug: "newsjack" (no topic) → agent asks which story → user replies
// with just the topic ("llm war, gpt new models, meta launching their own") —
// a plain topic with ZERO newsjacking trigger words. Plain selectSkills on
// that reply alone selects nothing, so the skill's mandatory
// "call search_news before drafting" instruction never re-fires and the model
// wrote from stale training-data memory instead of grounding in the topic.
//
// Fix: findOpenSpecializedSkill walks history STRUCTURALLY (not a fixed
// lookback window) — it keeps a specialized skill (newsjack/brandjack/
// namejack/lead-magnet) "open" for as long as the thread hasn't produced a
// draft since it was raised, however many turns that takes, and drops it the
// instant a draft IS rendered or a different specialized request arrives.
// selectSkillsWithContinuation then merges that carried skill into selection.
// ---------------------------------------------------------------------------

function userMsg(text: string): ChatMessage {
  return { role: "user", content: text };
}
function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", content: text };
}
function assistantDraft(text: string, tool: "render_post" | "render_hook" | "render_cite" = "render_post"): ChatMessage {
  return {
    role: "assistant",
    content: text,
    tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: "{}" } }],
  };
}

describe("findOpenSpecializedSkill", () => {
  test("the reported scenario: one exchange back, no draft since", () => {
    const history: ChatMessage[] = [
      userMsg("newsjack"),
      assistantMsg("Which story would you like to newsjack?"),
      userMsg("the llm war, gpt and meta launching new models"),
    ];
    expect(findOpenSpecializedSkill(history)?.id).toBe("newsjacking");
    // latestUserText, untouched, still returns ONLY the newest turn.
    expect(latestUserText(history)).toBe("the llm war, gpt and meta launching new models");
  });

  test("stays open across MULTIPLE clarifying exchanges, not just one turn back", () => {
    const history: ChatMessage[] = [
      userMsg("newsjack"),
      assistantMsg("Which story?"),
      userMsg("something about AI"),
      assistantMsg("Can you be more specific — which AI story?"),
      userMsg("the llm war, gpt and meta launching new models"),
    ];
    expect(findOpenSpecializedSkill(history)?.id).toBe("newsjacking");
  });

  test("a rendered draft CLOSES the open question — no longer carried forward", () => {
    const history: ChatMessage[] = [
      userMsg("newsjack the gpt launch"),
      assistantDraft("Here's your draft.", "render_post"),
      userMsg("make it shorter"),
    ];
    expect(findOpenSpecializedSkill(history)).toBeNull();
  });

  test("a render_hook or render_cite also closes the open question", () => {
    for (const tool of ["render_hook", "render_cite"] as const) {
      const history: ChatMessage[] = [
        userMsg("newsjack the gpt launch"),
        assistantDraft("Here you go.", tool),
        userMsg("thanks, can you tweak the tone"),
      ];
      expect(findOpenSpecializedSkill(history)).toBeNull();
    }
  });

  test("a DIFFERENT specialized request later in the chat wins, doesn't inherit the older one", () => {
    const history: ChatMessage[] = [
      userMsg("newsjack"),
      assistantMsg("Which story?"),
      userMsg("actually, brandjack Notion instead — they just raised a round"),
    ];
    expect(findOpenSpecializedSkill(history)?.id).toBe("brandjacking");
  });

  test("no specialized skill anywhere in the window → null", () => {
    const history: ChatMessage[] = [
      userMsg("can you tighten this up?"),
      assistantMsg("Sure — here's a tighter version."),
      userMsg("make the hook punchier"),
    ];
    expect(findOpenSpecializedSkill(history)).toBeNull();
  });

  test("empty history → null", () => {
    expect(findOpenSpecializedSkill([])).toBeNull();
  });

  test("stops walking after the lookback cap — doesn't scan an unbounded chat", () => {
    // 20 plain back-and-forth turns with no specialized skill anywhere; must
    // terminate (not hang) and return null.
    const history: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(userMsg(`turn ${i}`));
      history.push(assistantMsg(`reply ${i}`));
    }
    expect(findOpenSpecializedSkill(history)).toBeNull();
  });

  test("content-block user messages are read correctly", () => {
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
    expect(findOpenSpecializedSkill(history)?.id).toBe("newsjacking");
  });
});

describe("selectSkillsWithContinuation", () => {
  const NEWSJACKING = SKILLS.find((s) => s.id === "newsjacking")!;
  const LEAD_MAGNET = SKILLS.find((s) => s.id === "lead-magnet")!;

  test("merges a carried specialized skill in when the latest turn has none", () => {
    const ids = selectSkillsWithContinuation(
      "the llm war, gpt and meta launching new models",
      NEWSJACKING,
    ).map((s) => s.id);
    expect(ids).toContain("newsjacking");
  });

  test("a null carried skill is a no-op (matches plain selectSkills)", () => {
    const ids = selectSkillsWithContinuation("make the hook punchier", null).map((s) => s.id);
    expect(ids).not.toContain("newsjacking");
  });

  test("does NOT let the carried skill override a DIFFERENT specialized request in the latest turn", () => {
    const skills = selectSkillsWithContinuation(
      "actually give me a lead magnet giveaway post instead",
      NEWSJACKING, // stale carry that should be ignored
    );
    const ids = skills.map((s) => s.id);
    expect(ids).toContain("lead-magnet");
    expect(ids[0]).toBe("lead-magnet");
    // The carried skill must not sneak in alongside the explicit new request.
    expect(ids).not.toContain("newsjacking");
  });

  test("latest turn alone already selecting a specialized skill ignores the carry entirely", () => {
    const ids = selectSkillsWithContinuation(
      "newsjack the fed's rate decision",
      LEAD_MAGNET,
    ).map((s) => s.id);
    expect(ids[0]).toBe("newsjacking");
    expect(ids).not.toContain("lead-magnet");
  });

  test("respects the cap (max 3) even after carrying a skill forward", () => {
    const skills = selectSkillsWithContinuation(
      "hook it up, sound like me, rewrite this in my voice",
      NEWSJACKING,
      3,
    );
    expect(skills.length).toBeLessThanOrEqual(3);
    expect(skills.map((s) => s.id)).toContain("newsjacking");
  });
});
