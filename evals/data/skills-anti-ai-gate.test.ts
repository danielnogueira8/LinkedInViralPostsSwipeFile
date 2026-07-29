import { describe, expect, test } from "vitest";
import { SKILLS, selectSkills } from "@/lib/agent/skills";

// ---------------------------------------------------------------------------
// anti-ai is imported from the Claude skill, which requires EXPLICIT invocation:
// "ONLY use this skill when the user explicitly invokes it by name … Do NOT
// trigger on paraphrased intent such as 'humanize this' or 'make it sound less
// AI'."
//
// Our selector is substring matching, which is exactly the paraphrase-triggering
// that forbids. The skill licenses heavy rewriting — restructuring and cutting —
// so firing it on a casual "make this sound less AI" would mangle a draft the
// user only wanted tidied. Hence the explicitOnly gate, pinned here.
// ---------------------------------------------------------------------------

const ids = (msg: string) => selectSkills(msg).map((s) => s.id);

describe("anti-ai only loads when NAMED", () => {
  test("fires on the slash command and the bare name", () => {
    expect(ids("/anti-ai this draft")).toContain("anti-ai");
    expect(ids("run anti-ai on this")).toContain("anti-ai");
    expect(ids("use the anti-ai skill please")).toContain("anti-ai");
  });

  test("does NOT fire on paraphrased intent — the whole point of the gate", () => {
    for (const msg of [
      "humanize this",
      "make it sound less AI",
      "this reads like ChatGPT",
      "fix the writing style",
      "make this less robotic",
    ]) {
      expect(ids(msg), msg).not.toContain("anti-ai");
    }
  });

  test("a word merely containing the id doesn't count as naming it", () => {
    expect(ids("my anti-aircraft startup post")).not.toContain("anti-ai");
  });
});

describe("the gate is scoped to anti-ai only", () => {
  test("ordinary skills still trigger on paraphrase", () => {
    // Regression guard: the gate must not accidentally apply to every skill.
    expect(ids("write me a hook")).toContain("hooks");
    expect(ids("brandjack Notion")).toContain("brandjacking");
  });

  test("exactly one skill is explicit-only today", () => {
    const gated = SKILLS.filter((s) => s.explicitOnly).map((s) => s.id);
    expect(gated).toEqual(["anti-ai"]);
  });
});

describe("imported skill content survived the port", () => {
  const body = (id: string) => SKILLS.find((s) => s.id === id)?.body ?? "";

  test("anti-ai keeps the constraint that flipped a verified test", () => {
    // Significance-marking commentary was THE single pattern that turned a
    // passing rewrite into a 100%-AI verdict. If it's ever trimmed out, the
    // skill loses its most load-bearing rule.
    expect(body("anti-ai")).toMatch(/significance|what a moment MEANS|here's the thing/i);
  });

  test("anti-ai includes the de-ai reader-tell audit and word-bank references", () => {
    const antiAi = body("anti-ai");

    expect(antiAi).toMatch(/reader-facing tells/i);
    expect(antiAi).toMatch(/negative parallelism/i);
    expect(antiAi).toMatch(/participial tail/i);
    expect(antiAi).toMatch(/bold-first bullets/i);
    expect(antiAi).toMatch(/tier 1 must reach zero/i);
    expect(antiAi).toMatch(/tier 2 is allowed alone but banned in clusters/i);
    expect(antiAi).toMatch(/Tells: N → M/);
  });

  test("anti-ai keeps reader cleanup distinct from detector rewriting", () => {
    const antiAi = body("anti-ai");

    expect(antiAi).toMatch(/DETECTOR-FIRST mode/);
    expect(antiAi).toMatch(/SURGICAL mode/);
    expect(antiAi).toMatch(/does NOT prove a detector pass/i);
    expect(antiAi).toMatch(/detector protocol overrides the surgical-preservation rules/i);
    expect(antiAi).toMatch(/never invent anecdotes, names, dates, numbers/i);
  });

  test("the -jacking skills gained worked patterns", () => {
    for (const id of ["newsjacking", "brandjacking", "namejacking"]) {
      expect(body(id), id).toMatch(/Worked patterns/);
    }
  });

  test("safety rules survived — these are legal, not stylistic", () => {
    expect(body("namejacking")).toMatch(/never fabricate|NEVER fabricate/i);
    expect(body("brandjacking")).toMatch(/not impersonation|NOT impersonation/i);
    expect(body("newsjacking")).toMatch(/never from memory|confirm the event/i);
  });
});
