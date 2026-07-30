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

  test("the Cowork newsjack starter selects the grounded newsjacking skill", () => {
    const got = ids(
      "Newsjack a recent event about AI agents. Search for verified news from the last 14 days first and write a timely LinkedIn post in my voice.",
    );
    expect(got).toContain("newsjacking");
    expect(got[0]).toBe("newsjacking");
  });

  test("an explicit modeling request selects model-from-source (specialized, survives the cap)", () => {
    const got = ids("Model this post for me — same structure, my facts, in my voice");
    expect(got).toContain("model-from-source");
    expect(got[0]).toBe("model-from-source");
  });

  test("modeling phrasings all trigger it", () => {
    for (const msg of [
      "Swipe this post and make it mine",
      "Here's a post that worked — do mine",
      "My version of this post, please",
      "Rewrite this with my numbers",
    ]) {
      expect(ids(msg)).toContain("model-from-source");
    }
  });

  test("a plain original-post request does NOT trigger modeling", () => {
    expect(ids("write a post about pricing strategy in my voice")).not.toContain(
      "model-from-source",
    );
  });

  test("an original-post request selects the original-post craft skill", () => {
    const got = ids("Write a post about why most onboarding flows lose users");
    expect(got).toEqual(["original-post"]);
  });

  test("original-post absorbs the redundant voice-match skill but keeps other requested craft guidance", () => {
    expect(
      ids("Write a post about onboarding with a strong hook in my voice"),
    ).toEqual(["hooks", "original-post"]);
  });

  test("original-post does NOT fire on modeling, refine, or newsjack phrasing", () => {
    expect(ids("Model this post for me — same structure, my facts")).not.toContain(
      "original-post",
    );
    expect(ids("newsjack the OpenAI announcement with a punchy hook")).not.toContain(
      "original-post",
    );
  });

  test("original-post ranks after post-type specialized skills when both trip", () => {
    // "Newsjack … and write a post about it": the newsjack guidance must win
    // the cap ahead of the generic original-post craft.
    const got = ids("newsjack the OpenAI launch and write a post about what it means");
    expect(got).toContain("newsjacking");
    expect(got.indexOf("newsjacking")).toBeLessThan(
      got.includes("original-post") ? got.indexOf("original-post") : Number.MAX_SAFE_INTEGER,
    );
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

describe("selectSkills — interview-me", () => {
  test("a bare 'interview me' selects just the interview skill", () => {
    expect(ids("interview me")).toEqual(["interview-me"]);
  });

  test("the Cowork Interview-me starter prompt selects the interview skill", () => {
    const got = ids(
      "Interview me so you always have fresh context and new content angles. Ask me 3-5 short questions, one or two at a time — things you don't already know about me — then save what you learn as knowledge for future posts.",
    );
    expect(got).toContain("interview-me");
    expect(got[0]).toBe("interview-me");
  });

  test("the interview skill ranks ahead of generic craft skills", () => {
    const got = ids("interview me — and ask about my hook style");
    expect(got[0]).toBe("interview-me");
  });
});

describe("selectSkills — registry integrity", () => {
  test("exactly the high-intent skills are flagged specialized", () => {
    // anti-ai joins the post-type skills as specialized: when the user names it
    // they are asking for that rewrite specifically, so it must never be the
    // one silently dropped by the selection cap. It is additionally gated by
    // explicitOnly (see skills-anti-ai-gate.test.ts).
    const specialized = SKILLS.filter((s) => s.specialized).map((s) => s.id).sort();
    expect(specialized).toEqual(
      ["anti-ai", "brandjacking", "interview-me", "lead-magnet", "model-from-source", "namejacking", "newsjacking"].sort(),
    );
  });

  test("the generic craft skills are NOT specialized", () => {
    for (const id of ["hooks", "voice-match"]) {
      const s = SKILLS.find((x) => x.id === id);
      expect(s?.specialized).toBeFalsy();
    }
  });
});
