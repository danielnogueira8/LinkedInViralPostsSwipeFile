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
});
