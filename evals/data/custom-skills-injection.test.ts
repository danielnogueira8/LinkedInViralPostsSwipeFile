import { describe, test, expect } from "vitest";
import {
  renderSkills,
  renderCombinedSkills,
  selectSkills,
  type Skill,
} from "@/lib/agent/skills";

// ---------------------------------------------------------------------------
// Custom-skill injection into the agent's skill block. The LOAD-BEARING property
// (the promise made to the founder): a turn that uses NO custom skill assembles
// a BYTE-IDENTICAL skill block to before this feature — so existing behavior is
// provably untouched. And a custom skill is framed as subordinate to the global
// rules so it can't override the anti-slop guarantees.
// ---------------------------------------------------------------------------

const fakeSkill = (id: string, body: string): Skill => ({ id, triggers: [], body });

describe("renderCombinedSkills — no custom skills → byte-identical to renderSkills", () => {
  test("with built-ins + NO custom bodies → exactly renderSkills(builtins)", () => {
    const builtins = [fakeSkill("a", "Built-in A guidance."), fakeSkill("b", "Built-in B.")];
    expect(renderCombinedSkills(builtins, [])).toBe(renderSkills(builtins));
  });

  test("with NO built-ins and NO custom → empty string (caller skips injection)", () => {
    expect(renderCombinedSkills([], [])).toBe("");
  });

  test("whitespace-only custom bodies are dropped → still byte-identical", () => {
    const builtins = [fakeSkill("a", "A")];
    expect(renderCombinedSkills(builtins, ["", "   ", "\n"])).toBe(renderSkills(builtins));
  });

  // Real built-in selection: a message that triggers NO built-in skill and uses
  // NO custom skill must yield an empty block (the today behavior).
  test("a no-trigger message with no custom skill → empty block", () => {
    const builtins = selectSkills("hello there"); // no triggers
    expect(renderCombinedSkills(builtins, [])).toBe("");
  });
});

describe("renderCombinedSkills — custom skills inject + stay subordinate", () => {
  test("a custom body is included, framed as user guidance the global rules override", () => {
    const out = renderCombinedSkills([], ["Always end with my newsletter CTA."]);
    expect(out).toContain("Always end with my newsletter CTA.");
    // Framed so the global writing rules win.
    expect(out).toMatch(/global writing rules|always win/i);
  });

  test("custom bodies append AFTER the built-in block, separated", () => {
    const builtins = [fakeSkill("a", "Built-in A.")];
    const out = renderCombinedSkills(builtins, ["Custom guidance."]);
    expect(out.indexOf("Built-in A.")).toBeLessThan(out.indexOf("Custom guidance."));
    expect(out).toContain("\n\n---\n\n"); // separator between blocks
  });

  test("multiple custom bodies are all included, in order", () => {
    const out = renderCombinedSkills([], ["First custom.", "Second custom."]);
    expect(out.indexOf("First custom.")).toBeLessThan(out.indexOf("Second custom."));
  });

  test("custom-only (no built-in match) still produces a block", () => {
    const out = renderCombinedSkills([], ["My only guidance."]);
    expect(out).toContain("My only guidance.");
    expect(out).not.toBe(""); // injection happens
  });
});

// ---------------------------------------------------------------------------
// The /name labeling — the bug 2 fix. Without a /slug header the agent reading
// the prompt saw "guidance" but couldn't resolve user phrasing like "use that
// skill" to it, and asked back "which skill?" The fix adds a `## /name` header
// per body and a top-line summary so the agent can match the user's reference.
// ---------------------------------------------------------------------------
describe("renderCombinedSkills — /name labeling so the agent can resolve 'that skill'", () => {
  test("each body gets a `## /name` header when names are provided", () => {
    const out = renderCombinedSkills(
      [],
      ["End with: comment GUIDE.", "Mention our newsletter."],
      ["cta", "newsletter-mention"],
    );
    expect(out).toContain("## /cta");
    expect(out).toContain("## /newsletter-mention");
    // The body stays right under the header.
    const ctaIdx = out.indexOf("## /cta");
    const ctaBodyIdx = out.indexOf("End with: comment GUIDE.");
    expect(ctaBodyIdx).toBeGreaterThan(ctaIdx);
  });

  test("the framing names the skill(s) by /slug so 'that skill' has a referent", () => {
    const out = renderCombinedSkills([], ["body"], ["cta"]);
    expect(out).toContain("/cta");
    expect(out).toMatch(/that skill|this skill|the skill/i);
  });

  test("no names supplied → no /slug headers (back-compat for callers that don't pass them)", () => {
    const out = renderCombinedSkills([], ["just a body"]);
    expect(out).not.toContain("## /");
    expect(out).toContain("just a body");
  });

  test("singular vs plural framing tracks the body count", () => {
    const one = renderCombinedSkills([], ["b"], ["a"]);
    const two = renderCombinedSkills([], ["b1", "b2"], ["a", "c"]);
    expect(one).toContain("saved skill:");
    expect(two).toContain("saved skills:");
  });
});
