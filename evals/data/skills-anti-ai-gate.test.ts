import { describe, expect, test } from "vitest";
import {
  ANTI_AI_READER_TELL_RULES,
  SKILLS,
  selectSkills,
} from "@/lib/agent/skills";

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

    expect(antiAi).toContain(ANTI_AI_READER_TELL_RULES);
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

  // ---- no-ai-slop contribution -------------------------------------------
  //
  // The `no-ai-slop` skill solves the OTHER half of the problem: anti-ai's
  // detector protocol licenses heavy roughening, while no-ai-slop is a human
  // editor that must not flatten the writer while cleaning tells. These pin the
  // parts that would be easy to lose in a future trim.

  test("anti-ai has an audit-only mode that returns no rewrite", () => {
    // Without this, "does this read as AI?" gets answered with a rewritten
    // draft the user never asked for.
    const antiAi = body("anti-ai");
    expect(antiAi).toMatch(/DETECT mode/);
    expect(antiAi).toMatch(/quote the offending line/i);
    expect(antiAi).toMatch(/DETECT mode returns no draft/i);
  });

  test("detect mode refuses to score or claim AI authorship", () => {
    // Detectors guess; a named pattern is evidence the user can check. Scoring
    // a draft out of ten or asserting "an AI wrote this" is exactly the false
    // authority the source skill forbids.
    const antiAi = body("anti-ai");
    expect(antiAi).toMatch(/detectors guess/i);
    expect(antiAi).toMatch(/never score the draft out of ten/i);
    expect(antiAi).toMatch(/never assert that an AI wrote it/i);
  });

  test("voice preservation is scoped to surgical and detect, not detector-first", () => {
    // The two goals genuinely conflict: detector-first is SUPPOSED to roughen a
    // piece past recognition. Applying minimum-effective-edit there would
    // neuter the protocol, so the override has to stay explicit.
    const antiAi = body("anti-ai");
    expect(antiAi).toMatch(/Editing principles \(SURGICAL and DETECT modes\)/);
    expect(antiAi).toMatch(/MINIMUM EFFECTIVE EDIT/);
    expect(antiAi).toMatch(/Detector-first mode overrides these/i);
  });

  test("anti-ai keeps the edit from sanding off the writer", () => {
    const antiAi = body("anti-ai");
    // Each of these exists because "cleaning" a draft into generic polished
    // prose is its own kind of slop.
    expect(antiAi).toMatch(/Leave strong human sentences alone/i);
    expect(antiAi).toMatch(/profanity|blunt language/i);
    expect(antiAi).toMatch(/KEEP "I think", "maybe" or "to be honest"/);
    expect(antiAi).toMatch(/Never invent claims, examples, stats/i);
  });

  test("anti-ai self-checks its own edit before returning it", () => {
    // The eval is the part that makes the rules bite. Skipping it is how a
    // rewrite ships carrying the tells it was meant to remove — and it must run
    // inline, not via a second agent we would have to pay for.
    const antiAi = body("anti-ai");
    expect(antiAi).toMatch(/Answer each one pass or fail/i);
    expect(antiAi).toMatch(/on any fail, fix the draft and check again/i);
    expect(antiAi).toMatch(/does not need a second agent/i);
  });

  test("kicker lines are deleted, not rewritten into better metaphors", () => {
    // The specific instruction most likely to be softened by a future edit,
    // and the one that changes the output most.
    expect(body("anti-ai")).toMatch(
      /DELETED rather than rewritten into better metaphors/i,
    );
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
