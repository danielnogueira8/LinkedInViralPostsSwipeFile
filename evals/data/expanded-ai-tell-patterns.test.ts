import { describe, expect, test } from "vitest";
import { aiTellMetrics } from "@/lib/agent/specialists/nets";

describe("expanded high-confidence AI-tell patterns", () => {
  const cases: Array<[string, string]> = [
    ["Great question! I hope this helps.", "chatbot-artifact"],
    ["Experts believe this market will grow.", "vague-attribution"],
    ["Imagine a world where every post goes viral.", "formulaic-opener"],
    ["The catch? It only works on Fridays.", "infomercial-hook"],
    ["Only time will tell.", "generic-closer"],
    ["This could potentially change the result.", "hedge-stack"],
    ["This marks a pivotal moment for creators.", "significance-inflation"],
    ["As of my last update, the feature was unavailable.", "model-disclaimer"],
    ["Add your name here: [Your Name]", "unfilled-placeholder"],
    ["See citeturn0search0 for details.", "citation-markup-leak"],
    ["#AI #SaaS #Growth #Marketing #Sales #Future", "hashtag-stuffing"],
    // The 6 new patterns from the humanizer taxonomy.
    ["This is a testament to what happens when you delve into the data.", "ai-vocabulary"],
    ["In order to grow, you have to ship.", "filler-phrase"],
    ["The hard truth is most founders never post consistently.", "authority-trope"],
    ["Let's dive in. Here is my framework.", "signposting"],
    ["It had no preference. No prior. No nostalgia.", "staccato-negation"],
    ["Honestly? Most advice about hooks is wrong.", "rhetorical-opener"],
  ];

  test.each(cases)("detects %s", (body, expected) => {
    expect(aiTellMetrics(body)).toContain(expected);
  });

  test("does not flag attributed research or a short hashtag set", () => {
    expect(
      aiTellMetrics(
        "In its 2025 report, Gartner measured a 12% increase. #SaaS #Research",
      ),
    ).toEqual([]);
  });

  // FALSE-POSITIVE GUARDS: normal, good LinkedIn copy must NOT trip the new
  // patterns — over-repairing a clean post is worse than missing a tell.
  test.each([
    // A real sentence that starts with "Here's" (not the signposting phrases).
    "Here's the post I wrote for a client last week, and it landed 40 comments.",
    // "Just" used naturally, not as a fragment-initial staccato run.
    "I just want one thing from a hook: it has to earn the second line.",
    // Plain, concrete, human copy.
    "We cut churn 40% by fixing onboarding. One boring change, three months of work.",
    // A concrete result, no tells.
    "Cold outreach still works. I booked 12 calls last month from 200 messages.",
  ])("clean copy stays clean: %s", (body) => {
    expect(aiTellMetrics(body)).toEqual([]);
  });

  // The NEW staccato-negation is a RUN of two short negation fragments; a lone
  // one is left to the pre-existing dismissive-negation, and this must NOT be
  // the pattern that fires on a single "No excuses."
  test("a lone short negation is NOT staccato-negation (only a run is)", () => {
    expect(aiTellMetrics("No excuses. I shipped it and the numbers spoke.")).not.toContain(
      "staccato-negation",
    );
  });
});
