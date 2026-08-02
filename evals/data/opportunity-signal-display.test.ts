import { describe, expect, test } from "vitest";
import { isDisplayableDiscoveryOpportunity } from "@/lib/agent-loop/opportunity-signal";

describe("discovery opportunity display eligibility", () => {
  test("hides legacy keyword-only Trend Radar cards", () => {
    expect(
      isDisplayableDiscoveryOpportunity("trend", {
        signal_type: "trend_radar",
        headline:
          "checks, claude, comment, content, effort, lead: an emerging creator conversation",
      }),
    ).toBe(false);
  });

  test("shows semantically curated Trend Radar cards and Newsjacking cards", () => {
    expect(
      isDisplayableDiscoveryOpportunity("trend", {
        signal_type: "trend_radar",
        curation_version: 2,
      }),
    ).toBe(true);
    expect(
      isDisplayableDiscoveryOpportunity("news", {
        signal_type: "newsjacking",
      }),
    ).toBe(true);
  });
});
