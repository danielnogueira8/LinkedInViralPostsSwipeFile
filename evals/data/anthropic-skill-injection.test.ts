import { describe, test, expect } from "vitest";
import { renderCombinedSkills, type Skill } from "@/lib/agent/skills";
import { translateMessages } from "@/lib/anthropic";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// The migration's whole reason to exist: workspace custom skills must keep
// working on Anthropic. Skills are plain prompt text — resolved to a body,
// wrapped by renderCombinedSkills, and joined into a role:"system" ChatMessage
// in lib/agent/execute/writer.ts. This test chains that exact hop through the
// Anthropic adapter's translateMessages and proves the skill body lands, intact
// and subordinate, in the top-level `system` field Anthropic reads — i.e. the
// skill still steers the model after the provider swap. If this passes, "skills
// under one bill" holds at the transport boundary.
// ---------------------------------------------------------------------------

const fakeBuiltin = (id: string, body: string): Skill => ({
  id,
  triggers: [],
  body,
});

// Mirror how writer.ts assembles the system message: a few global rules, then
// the rendered skills block, joined with the same "\n\n" .filter(Boolean).join.
function buildWriterSystemMessage(skillsBlock: string): ChatMessage {
  return {
    role: "system",
    content: [
      "You are SwipeIn's grounded LinkedIn post writer.",
      "GLOBAL: never use em-dashes.",
      skillsBlock,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

describe("custom skill survives the Anthropic transport (system hoist)", () => {
  test("a custom skill body reaches the Anthropic top-level system field", () => {
    const skillBody = "Always end every post with my newsletter CTA.";
    const block = renderCombinedSkills([], [skillBody], ["Newsletter CTA"]);
    const messages: ChatMessage[] = [
      buildWriterSystemMessage(block),
      { role: "user", content: "write me a post about churn" },
    ];

    const { system, messages: out } = translateMessages(messages);

    // The skill body is present in the hoisted system prompt...
    expect(system).toContain(skillBody);
    // ...wrapped as user-authored data, and named.
    expect(system).toContain("<user_skill");
    expect(system).toContain("Newsletter CTA");
    // ...alongside the global rule it must stay subordinate to.
    expect(system).toContain("never use em-dashes");
    // The system message is hoisted OUT of the messages array (Anthropic needs
    // system top-level), leaving only the user turn.
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  test("multiple custom skills all land in system, in order", () => {
    const block = renderCombinedSkills(
      [fakeBuiltin("hooks", "Open with a bold hook.")],
      ["First custom rule.", "Second custom rule."],
      ["A", "B"],
    );
    const { system } = translateMessages([
      buildWriterSystemMessage(block),
      { role: "user", content: "go" },
    ]);
    expect(system).toContain("First custom rule.");
    expect(system).toContain("Second custom rule.");
    expect(system!.indexOf("First custom rule.")).toBeLessThan(
      system!.indexOf("Second custom rule."),
    );
  });

  test("a turn with NO custom skill still hoists the base system prompt unchanged", () => {
    // Byte-identical promise: renderCombinedSkills([],[]) is "" and drops out of
    // the join, so the system prompt is exactly the global rules.
    const block = renderCombinedSkills([], []);
    expect(block).toBe("");
    const { system } = translateMessages([
      buildWriterSystemMessage(block),
      { role: "user", content: "go" },
    ]);
    expect(system).toBe(
      "You are SwipeIn's grounded LinkedIn post writer.\n\nGLOBAL: never use em-dashes.",
    );
    expect(system).not.toContain("<user_skill");
  });
});
