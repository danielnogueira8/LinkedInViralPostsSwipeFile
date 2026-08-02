import { describe, expect, test } from "vitest";
import {
  buildNewsjackingQuery,
  hasCreatorCoverage,
  newsjackingOperationKey,
  rankNewsjackingCandidates,
  newsjackingOpportunityPayload,
} from "@/lib/agent-loop/newsjacking";

const NOW = new Date("2026-08-01T12:00:00.000Z");

describe("Newsjacking discovery contract", () => {
  test("uses one stable operation bucket for the whole day", () => {
    expect(
      newsjackingOperationKey("workspace-1", new Date("2026-08-01T06:00:00Z")),
    ).toBe(
      newsjackingOperationKey("workspace-1", new Date("2026-08-01T23:59:59Z")),
    );
    expect(
      newsjackingOperationKey("workspace-1", new Date("2026-08-02T00:00:00Z")),
    ).not.toBe(
      newsjackingOperationKey("workspace-1", new Date("2026-08-01T23:59:59Z")),
    );
  });

  test("builds a current-event query with platform and workspace lanes", () => {
    const query = buildNewsjackingQuery(["B2B SaaS", "founder-led marketing"]);

    expect(query).toContain("LinkedIn");
    expect(query.toLowerCase()).toContain("ai slop");
    expect(query).toContain("B2B SaaS");
    expect(query).toContain("founder-led marketing");
    expect(query.toLowerCase()).toContain("tracked creators");
  });

  test("keeps only fresh, usable, distinct signals and ranks them by signal quality", () => {
    const candidates = rankNewsjackingCandidates(
      [
        {
          title: "LinkedIn introduces an AI slop label",
          url: "https://news.linkedin.com/2026/keeping-conversations-real",
          source: "LinkedIn News",
          published_at: "2026-08-01",
          summary:
            "LinkedIn explains how it will identify low-effort AI content.",
        },
        {
          title: "This changes what creators should publish",
          url: "https://x.com/creator/status/123",
          source: "X",
          published_at: "2026-08-01",
          summary:
            "A creator reacts to LinkedIn's new label for low-effort AI content.",
        },
        {
          title: "Another reaction to the new creator label",
          url: "https://x.com/creator/status/123",
          source: "X",
          published_at: "2026-08-01",
          summary:
            "LinkedIn's low-effort AI content label has changed publishing incentives.",
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
    expect(candidates[0].corroboratingResults).toHaveLength(1);
    expect(candidates[0].corroboratingResults?.[0]?.url).toContain("x.com");
  });

  test("uses social posts as corroboration, never as the only event proof", () => {
    const candidates = rankNewsjackingCandidates(
      [
        {
          title: "Creators discuss a rumored platform change",
          url: "https://x.com/creator/status/999",
          source: "X",
          published_at: "2026-08-01",
          summary: "A creator says the platform may change its feed.",
        },
      ],
      NOW,
      ["creator marketing"],
    );
    expect(candidates).toEqual([]);
  });

  test("preserves exact-title social corroboration for short event names", () => {
    const candidates = rankNewsjackingCandidates(
      [
        {
          title: "LinkedIn announces Atlas",
          url: "https://news.linkedin.com/atlas",
          source: "LinkedIn News",
          published_at: "2026-08-01",
          summary: "LinkedIn announces its Atlas product.",
        },
        {
          title: "LinkedIn announces Atlas",
          url: "https://x.com/creator/status/atlas",
          source: "X",
          published_at: "2026-08-01",
          summary: "A creator reacts to the Atlas announcement.",
        },
      ],
      NOW,
      [],
    );

    expect(candidates[0]?.corroboratingResults?.[0]?.url).toContain("x.com");
  });

  test("assigns a duplicated social URL to only one exact-title event", () => {
    const sharedSocialUrl = "https://x.com/creator/status/shared";
    const candidates = rankNewsjackingCandidates(
      [
        {
          title: "LinkedIn announces Atlas",
          url: "https://news.linkedin.com/atlas",
          source: "LinkedIn News",
          published_at: "2026-08-01",
          summary: "LinkedIn announces its Atlas product.",
        },
        {
          title: "LinkedIn announces Atlas",
          url: sharedSocialUrl,
          source: "X",
          published_at: "2026-08-01",
          summary: "A creator reacts to Atlas.",
        },
        {
          title: "OpenAI announces Nova",
          url: "https://openai.com/nova",
          source: "OpenAI",
          published_at: "2026-08-01",
          summary: "OpenAI announces its Nova product.",
        },
        {
          title: "OpenAI announces Nova",
          url: sharedSocialUrl,
          source: "X",
          published_at: "2026-08-01",
          summary: "A creator reacts to Nova.",
        },
      ],
      NOW,
      [],
    );

    const attachedUrls = candidates.flatMap((candidate) =>
      (candidate.corroboratingResults ?? []).map((entry) => entry.url),
    );
    expect(attachedUrls.filter((url) => url === sharedSocialUrl)).toHaveLength(1);
  });

  test("does not attach an unrelated social conversation to verified news", () => {
    const candidates = rankNewsjackingCandidates(
      [
        {
          title: "LinkedIn introduces an AI slop label",
          url: "https://news.linkedin.com/2026/keeping-conversations-real",
          source: "LinkedIn News",
          published_at: "2026-08-01",
          summary:
            "LinkedIn explains how it will identify low-effort AI content.",
        },
        {
          title: "Three ways to schedule LinkedIn AI content",
          url: "https://x.com/creator/status/456",
          source: "X",
          published_at: "2026-08-01",
          summary:
            "A creator explains how to use AI content in a LinkedIn posting calendar.",
        },
      ],
      NOW,
      ["LinkedIn writing"],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].corroboratingResults).toEqual([]);
  });

  test("does not confuse an evergreen topical guide with a current event", () => {
    const candidates = rankNewsjackingCandidates(
      [
        {
          title: "OpenAI announces pricing changes",
          url: "https://openai.com/pricing-update",
          source: "OpenAI",
          published_at: "2026-08-01",
          summary: "OpenAI will change pricing for several models.",
        },
        {
          title: "We are launching OpenAI pricing guides",
          url: "https://x.com/creator/status/pricing-guide",
          source: "X",
          published_at: "2026-08-01",
          summary:
            "These OpenAI pricing how-to guides help startup teams estimate costs.",
        },
      ],
      NOW,
      ["AI startups"],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].corroboratingResults).toEqual([]);
  });

  test("does not treat an arbitrary non-social blog as authoritative proof", () => {
    const candidates = rankNewsjackingCandidates(
      [
        {
          title:
            "LinkedIn reportedly changes how the feed works — LinkedIn Updates",
          url: "https://linkedin-updates.com/linkedin-feed-rumor",
          source: "LinkedIn Updates",
          published_at: "2026-08-01",
          summary: "An unverified blog claims LinkedIn changed its feed.",
        },
      ],
      NOW,
      ["LinkedIn writing"],
    );
    expect(candidates).toEqual([]);
  });

  test("does not trust user-controlled subdomains of an approved platform", () => {
    const candidates = rankNewsjackingCandidates(
      [
        {
          title: "LinkedIn reportedly changes how the feed works",
          url: "https://sites.google.com/view/linkedin-feed-rumor",
          source: "Google Sites",
          published_at: "2026-08-01",
          summary: "A user-created page claims LinkedIn changed its feed.",
        },
      ],
      NOW,
      ["LinkedIn writing"],
    );
    expect(candidates).toEqual([]);
  });

  test("persists a signal as an explicit verified Newsjacking opportunity", () => {
    const candidate = {
      title: "LinkedIn introduces an AI slop label",
      url: "https://news.linkedin.com/2026/keeping-conversations-real",
      source: "LinkedIn News",
      published_at: "2026-08-01",
      summary: "LinkedIn explains how it will identify low-effort AI content.",
    };

    expect(
      newsjackingOpportunityPayload(candidate, ["B2B SaaS"], NOW),
    ).toMatchObject({
      headline: "LinkedIn introduces an AI slop label",
      source_url: candidate.url,
      source_name: "LinkedIn News",
      signal_state: "early",
      creator_coverage: "none_observed",
      signal_type: "newsjacking",
      reason: "verified_external_event",
    });
  });

  test("does not promote sensitive events and can verify creator coverage", () => {
    expect(
      rankNewsjackingCandidates(
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
    expect(
      hasCreatorCoverage(signal, ["We discussed AI slop in our team."]),
    ).toBe(true);
    expect(hasCreatorCoverage(signal, ["A post about hiring managers."])).toBe(
      false,
    );
  });
});
