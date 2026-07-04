import { describe, test, expect } from "vitest";
import {
  splitSentences,
  wordCount,
  findRuleOfThree,
  findUniformLengthRun,
  findParataxisRun,
  countEmDashes,
  exceedsEmDashCap,
  findBannedWords,
  findDismissiveNegation,
  structuralViolations,
} from "../anti-slop-detectors";

// ---------------------------------------------------------------------------
// Unit tests for the anti-AI-slop structural detectors. These guard the
// detectors themselves (so the live suite that uses them is trustworthy) and
// pin the exact patterns from the real regression: the "Not 5. Not 10. Two."
// rule-of-three draft that slipped past the skill.
// ---------------------------------------------------------------------------

// The actual lines from the draft a user flagged (rule-of-three not respected).
const FLAGGED_DRAFT_LINES = [
  "Your hook has 2 seconds to earn the scroll.",
  "Not 5. Not 10. Two.",
  "Numbers, timeframes, names. Vague hooks die quietly.",
  "The best hooks make you slightly uncomfortable, slightly curious, or slightly argumentative.",
];

describe("helpers", () => {
  test("splitSentences splits on terminal punctuation", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
    expect(splitSentences("Not 5. Not 10. Two.")).toEqual(["Not 5.", "Not 10.", "Two."]);
  });
  test("wordCount ignores punctuation and numbers-as-words", () => {
    expect(wordCount("Not 5.")).toBe(2);
    expect(wordCount("Two.")).toBe(1);
    expect(wordCount("")).toBe(0);
  });
});

describe("findRuleOfThree — catches the real regression", () => {
  test("the staccato triad 'Not 5. Not 10. Two.'", () => {
    const hits = findRuleOfThree("Your hook has 2 seconds. Not 5. Not 10. Two.");
    expect(hits.some((h) => h.kind === "staccato")).toBe(true);
  });

  test("the comma-list triad 'Numbers, timeframes, names.'", () => {
    const hits = findRuleOfThree("Be specific. Numbers, timeframes, names. Vague hooks die.");
    expect(hits.some((h) => h.kind === "comma-list" && /Numbers, timeframes, names/.test(h.text))).toBe(true);
  });

  test("the whole flagged draft trips the detector", () => {
    const hits = findRuleOfThree(FLAGGED_DRAFT_LINES.join("\n"));
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("findRuleOfThree — does NOT false-positive", () => {
  test("a two-beat staccato is fine", () => {
    expect(findRuleOfThree("Not 5. Two.")).toEqual([]);
  });

  test("a FOUR-beat run is fine (deliberate rhythm, not the AI triad)", () => {
    expect(findRuleOfThree("Not 5. Not 10. Not 8. Two.")).toEqual([]);
  });

  test("an Oxford 'a, b, and c' list is fine", () => {
    expect(findRuleOfThree("Use numbers, timeframes, and names.")).toEqual([]);
    expect(findRuleOfThree("Pick blunt, casual, or warm.")).toEqual([]);
  });

  test("three SUBSTANTIAL sentences (not short) aren't a staccato triad", () => {
    const text =
      "Leading with the result stops the scroll because the reader wants the payoff. " +
      "Being specific earns attention because vague claims read as filler. " +
      "Making one clear claim keeps the opener from diluting itself across two ideas.";
    // These are long + connective-rich, so neither staccato nor comma-list fires.
    expect(findRuleOfThree(text)).toEqual([]);
  });

  test("normal prose with commas isn't flagged", () => {
    expect(
      findRuleOfThree("I've written hooks for 40+ founders over 6 years, and most fail the same way."),
    ).toEqual([]);
  });
});

describe("findUniformLengthRun", () => {
  test("flags FOUR+ consecutive same-length sentences", () => {
    // Four 6-word sentences in a row — the loosened (lower-false-positive) bar.
    const text =
      "The hook must earn the click. The body must deliver the goods. The close must drive the action. The post must respect the reader.";
    const runs = findUniformLengthRun(text);
    expect(runs.length).toBeGreaterThan(0);
  });

  test("does NOT flag just three same-length sentences (common in good prose)", () => {
    const text =
      "The hook must earn the click. The body must deliver the goods. The close must drive the action.";
    expect(findUniformLengthRun(text)).toEqual([]);
  });

  test("does not flag varied sentence lengths", () => {
    const text =
      "Lead with the punch. Then, once you've earned the click, you can take your time unpacking the idea across as many sentences as it genuinely needs. Stop when you're done.";
    expect(findUniformLengthRun(text)).toEqual([]);
  });
});

describe("findParataxisRun", () => {
  test("flags a MONOTONOUS run of 4+ uniform blunt declaratives", () => {
    // Four ~3-word sentences, no connectives, near-uniform length → the tell.
    const text = "It moves fast. It cuts deep. It reads clean. It stops scrolls.";
    const runs = findParataxisRun(text);
    expect(runs.length).toBeGreaterThan(0);
  });

  test("does NOT flag expressive, varied-length fragments (a feature, not the tell)", () => {
    // The real draft's good fragments: lengths vary (1, 1, 6, 9 words), so this
    // is rhythm, not robotic parataxis.
    const text =
      "Curiosity. Friction. A claim that contradicts what they believe. A number that seems wrong until they read the next line.";
    expect(findParataxisRun(text)).toEqual([]);
  });

  test("does NOT flag a run of only three (two-to-four is fine)", () => {
    expect(findParataxisRun("It moves fast. It cuts deep. It reads clean.")).toEqual([]);
  });

  test("does not flag sentences with connective tissue", () => {
    const text =
      "It's short because brevity earns attention, but it still connects to the next idea, which keeps the reader moving.";
    expect(findParataxisRun(text)).toEqual([]);
  });
});

describe("em-dash cap", () => {
  test("counts em dashes (not hyphens)", () => {
    expect(countEmDashes("a — b — c")).toBe(2);
    expect(countEmDashes("a-b-c well-known")).toBe(0);
  });

  test("egregious em-dash salad (5 in a short post) exceeds the cap", () => {
    // The detector is the CI backstop — lenient (≈1 per 200 words, min 2), so it
    // only fails on real overuse, not a borderline second dash. Five in a short
    // post is the em-dash-salad tell.
    const text =
      "A post — peppered — with way — too many — em dashes — all over the place.";
    expect(exceedsEmDashCap(text)).toBe(true);
  });

  test("a couple of em dashes in a short post is within the lenient cap", () => {
    const text = "A short post — with two — em dashes, which is fine for a human.";
    expect(exceedsEmDashCap(text)).toBe(false);
  });

  test("one em dash is within the cap", () => {
    expect(exceedsEmDashCap("A short post — with exactly one em dash.")).toBe(false);
  });
});

describe("banned words", () => {
  test("catches flagrant banned vocab", () => {
    expect(findBannedWords("Let's delve into this seamless, transformative tapestry.")).toEqual(
      expect.arrayContaining(["delve", "seamless", "transformative", "tapestry"]),
    );
  });
  test("clean prose has none", () => {
    expect(findBannedWords("I wrote 4,000 hooks and most of them flopped.")).toEqual([]);
  });
  test("catches fancy words a plain-language post should replace", () => {
    expect(
      findBannedWords(
        "We utilize a myriad of tactics to facilitate growth. Commence with a plethora of tests.",
      ),
    ).toEqual(
      expect.arrayContaining(["utilize", "myriad", "facilitate", "commence", "plethora"]),
    );
  });
  test("plain-language control sentence stays clean (no false positives)", () => {
    // Domain terms + everyday words only — none of the fancy words appear.
    expect(
      findBannedWords("Cut churn by 12%. Use the runway you have. Talk to your ICP first."),
    ).toEqual([]);
  });
});

describe("findDismissiveNegation — the 'No theory.' pattern", () => {
  test("catches the flagged 'No theory.' fragment", () => {
    const text =
      "I'll walk through the system live. No theory. The actual hooks and DM sequences.";
    expect(findDismissiveNegation(text)).toContain("No theory.");
  });

  test("catches the family", () => {
    expect(findDismissiveNegation("No fluff. Here's the playbook.")).toContain("No fluff.");
    expect(findDismissiveNegation("Let's get into it. No BS.")).toContain("No BS.");
    expect(findDismissiveNegation("No gatekeeping. The whole thing.")).toContain(
      "No gatekeeping.",
    );
    expect(findDismissiveNegation("Not another listicle about productivity.")).toContain(
      "Not another listicle about productivity.",
    );
  });

  test("does NOT flag real 'No ...' sentences with a verb/clause", () => {
    expect(findDismissiveNegation("No one knows what actually works.")).toEqual([]);
    expect(findDismissiveNegation("No, I disagree with that take.")).toEqual([]);
    expect(findDismissiveNegation("No idea why it went viral.")).toEqual([]);
    expect(findDismissiveNegation("No problem — happy to help.")).toEqual([]);
    expect(findDismissiveNegation("There's no shortcut to writing well.")).toEqual([]);
  });
});

describe("structuralViolations — aggregate", () => {
  test("the 'No theory.' draft trips the dismissive-negation rule", () => {
    const v = structuralViolations(
      "I'll go live this week. No theory. The actual hooks, the DM sequences.",
    );
    expect(v.some((x) => x.rule === "dismissive-negation")).toBe(true);
  });


  test("the flagged draft produces violations", () => {
    const v = structuralViolations(FLAGGED_DRAFT_LINES.join("\n"));
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => x.rule === "rule-of-three")).toBe(true);
  });

  test("a clean, varied, human-sounding draft produces NO violations", () => {
    // Two-beat counts, varied sentence lengths, connective tissue, no banned
    // words, one em dash. This is the shape a good draft should have.
    const clean =
      "Most hook advice is noise. The thing that actually stops a thumb is specificity: a claim concrete enough that the reader's brain starts trying to verify it before they've decided to keep reading. " +
      '"You\'ll run out of cash in 47 days" lands because it hands you a number to check. ' +
      "Vague threats don't, so they get scrolled. " +
      "Write the opener last, after you know what the post actually proves — that's when you can make the first line carry its weight.";
    expect(structuralViolations(clean)).toEqual([]);
  });
});
