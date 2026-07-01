import { describe, test, expect } from "vitest";
import { selectSkills, SKILLS } from "@/lib/agent/skills/index";

// ---------------------------------------------------------------------------
// selectSkills — the built-in skill selector's PRIORITIZATION. The reported
// bug: brandjack/namejack post-type instructions exist and are injected, but
// the selection cap silently DROPPED them when a prompt also mentioned "voice"
// or "hook" (the jack skills sit late in the registry, and the old cap kept the
// first N in registry order). A user who explicitly typed "brandjack" then got
// no brandjacking guidance. The fix: specialized (explicit post-type) skills
// win the cap over the generic craft skills, and the cap is 3.
// ---------------------------------------------------------------------------

const ids = (msg: string) => selectSkills(msg).map((s) => s.id);

describe("selectSkills — specialized skills survive the cap", () => {
  test("the reported case: an explicit brandjack keeps the brandjacking skill", () => {
    // The screenshot's prompt — trips voice-match ("in my voice") too.
    const msg =
      "Brandjack LinkedIn — write a LinkedIn post in my voice that borrows their recognition. Do a teardown, a steal-this, or a versus.";
    expect(ids(msg)).toContain("brandjacking");
  });

  test("brandjack + hook + voice (3 matches) — brandjacking is NOT dropped", () => {
    // The exact regression: under the old max=2 registry-order cap this returned
    // [hooks, voice-match] and lost brandjacking. Now brandjacking ranks first.
    const got = ids("brandjack Notion with a killer hook, in my voice");
    expect(got).toContain("brandjacking");
    expect(got[0]).toBe("brandjacking"); // specialized ranked ahead of generic
  });

  test("namejack + hook + voice keeps namejacking", () => {
    const got = ids("namejack Justin Welsh — write an opener hook in my voice");
    expect(got).toContain("namejacking");
    expect(got[0]).toBe("namejacking");
  });

  test("lead-magnet + hook + voice keeps lead-magnet", () => {
    const got = ids("write a lead magnet post with a great hook in my voice");
    expect(got).toContain("lead-magnet");
    expect(got[0]).toBe("lead-magnet");
  });

  test("newsjack + hook + voice keeps newsjacking", () => {
    const got = ids("newsjack the OpenAI announcement with a punchy hook in my voice");
    expect(got).toContain("newsjacking");
    expect(got[0]).toBe("newsjacking");
  });
});

describe("selectSkills — cap and ordering invariants", () => {
  test("at most 3 skills are ever injected (prompt stays lean)", () => {
    // A kitchen-sink message that trips many triggers at once.
    const msg =
      "brandjack Notion with a killer hook in my voice as a lead magnet, newsjack the trending launch";
    expect(selectSkills(msg).length).toBeLessThanOrEqual(3);
  });

  test("a generic-only prompt injects only generic skills (no specialized false-positive)", () => {
    // No post-type keyword → the specialized skills must NOT appear.
    const got = ids("write a post in my voice with a strong hook");
    expect(got).toEqual(["hooks", "voice-match"]); // both generic, registry order
    expect(got.some((id) => ["brandjacking", "namejacking", "newsjacking", "lead-magnet"].includes(id))).toBe(false);
  });

  test("a bare specialized keyword selects just that skill", () => {
    expect(ids("brandjack Notion")).toEqual(["brandjacking"]);
    expect(ids("namejack Justin Welsh")).toEqual(["namejacking"]);
  });

  test("no trigger match → no skills", () => {
    expect(selectSkills("hello there, how are you?")).toEqual([]);
  });

  test("ordering is stable and deterministic across repeated calls", () => {
    const msg = "brandjack Notion with a hook in my voice";
    expect(ids(msg)).toEqual(ids(msg));
  });

  test("two specialized skills both survive, ahead of a generic one", () => {
    // "lead magnet" (specialized) + "brandjack" (specialized) + "hook" (generic):
    // both specialized rank ahead; the generic fills the 3rd slot.
    const got = ids("brandjack HubSpot as a lead magnet with a hook");
    expect(got.slice(0, 2).sort()).toEqual(["brandjacking", "lead-magnet"]);
    expect(got).toContain("hooks");
  });
});

describe("selectSkills — registry integrity", () => {
  test("exactly the four post-type skills are flagged specialized", () => {
    const specialized = SKILLS.filter((s) => s.specialized).map((s) => s.id).sort();
    expect(specialized).toEqual(
      ["brandjacking", "lead-magnet", "namejacking", "newsjacking"].sort(),
    );
  });

  test("the generic craft skills are NOT specialized", () => {
    for (const id of ["hooks", "voice-match"]) {
      const s = SKILLS.find((x) => x.id === id);
      expect(s?.specialized).toBeFalsy();
    }
  });
});
