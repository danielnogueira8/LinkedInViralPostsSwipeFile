import { describe, expect, test } from "vitest";
import {
  buildTrendRadarQuery,
  hasCreatorCoverage,
  rankTrendCandidates,
  trendOpportunityPayload,
} from "@/lib/agent-loop/trend-radar";

const NOW = new Date("2026-08-01T12:00:00.000Z");

describe("Trend Radar discovery contract", () => {
  test("builds a creator-independent query with platform and workspace lanes", () => {
    const query = buildTrendRadarQuery(["B2B SaaS", "founder-led marketing"]);

    expect(query).toContain("LinkedIn");
    expect(query.toLowerCase()).toContain("ai slop");
    expect(query).toContain("B2B SaaS");
    expect(query).toContain("founder-led marketing");
    expect(query.toLowerCase()).toContain("tracked creators");
  });

  test("keeps only fresh, usable, distinct signals and ranks them by signal quality", () => {
    const candidates = rankTrendCandidates(
      [
        {
          title: "LinkedIn introduces an AI slop label",
          url: "https://news.linkedin.com/2026/keeping-conversations-real",
          source: "LinkedIn News",
          published_at: "2026-08-01",
          summary: "LinkedIn explains how it will identify low-effort AI content.",
        },
        {
          title: "LinkedIn introduces an AI slop label",
          url: "https://example.com/duplicate-ai-slop-story",
          source: "Example",
          published_at: "2026-08-01",
          summary: "A second article covers the same development.",
        },
        {
          title: "A stale story",
          url: "https://example.com/stale",
          source: "Example",
          published_at: "2026-07-01",
          summary: "This is outside the radar window.",
        },
        {
          title: "An undated story",
          url: "https://example.com/undated",
          source: "Example",
          published_at: "",
          summary: "This cannot be verified as current.",
        },
      ],
      NOW,
      ["B2B SaaS"],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].result.url).toBe(
      "https://news.linkedin.com/2026/keeping-conversations-real",
    );
    expect(candidates[0].score).toBeGreaterThan(0);
  });

  test("persists a signal as an explicit creator-independent opportunity", () => {
    const candidate = {
      title: "LinkedIn introduces an AI slop label",
      url: "https://news.linkedin.com/2026/keeping-conversations-real",
      source: "LinkedIn News",
      published_at: "2026-08-01",
      summary: "LinkedIn explains how it will identify low-effort AI content.",
    };

    expect(
      trendOpportunityPayload(candidate, ["B2B SaaS"], NOW),
    ).toMatchObject({
      headline: "LinkedIn introduces an AI slop label",
      source_url: candidate.url,
      source_name: "LinkedIn News",
      signal_state: "early",
      creator_coverage: "none_observed",
      reason: "creator_independent",
    });
  });

  test("does not promote sensitive events and can verify creator coverage", () => {
    expect(
      rankTrendCandidates(
        [
          {
            title: "A tragic disaster dominates the news",
            url: "https://example.com/tragedy",
            source: "Example",
            published_at: "2026-08-01",
            summary: "A disaster with human suffering is being reported.",
          },
        ],
        NOW,
        [],
      ),
    ).toEqual([]);

    const signal = {
      title: "LinkedIn introduces an AI slop label",
      url: "https://news.linkedin.com/2026/keeping-conversations-real",
      source: "LinkedIn News",
      published_at: "2026-08-01",
      summary: "LinkedIn explains how it will identify low-effort AI content.",
    };
    expect(hasCreatorCoverage(signal, ["We discussed AI slop in our team."])).toBe(
      true,
    );
    expect(hasCreatorCoverage(signal, ["A post about hiring managers."])).toBe(
      false,
    );
  });
});
