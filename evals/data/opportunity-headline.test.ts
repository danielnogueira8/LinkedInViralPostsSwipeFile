import { describe, expect, test } from "vitest";
import {
  OPPORTUNITY_HEADLINE_FALLBACK,
  isLegacyOpportunityHeadline,
  readOpportunityHeadline,
  repairOpportunityHeadline,
} from "@/lib/agent-loop/headline";

// Verbatim shapes seen in production `agent_opportunities.payload.headline`
// rows written before PR #1323 changed the generator.
const LEGACY_2530 =
  'Ilan Asseo went 2530× — "The thing nobody tells you about hiring." — draft it?';
const LEGACY_VIRAL =
  'Ruben Hassid went viral — "How I use AI every morning." — draft it?';

describe("isLegacyOpportunityHeadline", () => {
  test("detects the pre-#1323 creator-multiplier phrasing", () => {
    expect(isLegacyOpportunityHeadline(LEGACY_2530)).toBe(true);
    expect(isLegacyOpportunityHeadline(LEGACY_VIRAL)).toBe(true);
    // lowercase x variant
    expect(
      isLegacyOpportunityHeadline('Ignacio Prma went 545x — "Hi." — draft it?'),
    ).toBe(true);
  });

  test("leaves current-format headlines alone", () => {
    expect(
      isLegacyOpportunityHeadline(
        'Ilan Asseo — 2.3k likes — "The thing nobody tells you." — draft it?',
      ),
    ).toBe(false);
  });
});

describe("repairOpportunityHeadline", () => {
  test("re-attributes the metric to the post, not the creator", () => {
    const repaired = repairOpportunityHeadline(LEGACY_2530, {
      author: "Ilan Asseo",
      metrics: { viral_score: 2530, reactions: 2080, comments: 150 },
    });
    expect(repaired).toBe(
      'Ilan Asseo — 2.1k likes — "The thing nobody tells you about hiring." — draft it?',
    );
    // The bogus multiplier is gone entirely.
    expect(repaired).not.toContain("went");
    expect(repaired).not.toContain("2530");
  });

  test("names comments when comments are the larger raw metric", () => {
    expect(
      repairOpportunityHeadline(LEGACY_VIRAL, {
        author: "Ruben Hassid",
        metrics: { reactions: 40, comments: 220 },
      }),
    ).toBe('Ruben Hassid — 220 comments — "How I use AI every morning." — draft it?');
  });

  test("drops the metric segment rather than inventing one when counts are absent", () => {
    expect(
      repairOpportunityHeadline(LEGACY_2530, {
        author: "Ilan Asseo",
        metrics: { viral_score: 2530 },
      }),
    ).toBe('Ilan Asseo — "The thing nobody tells you about hiring." — draft it?');
  });

  test("falls back to the author parsed out of the headline", () => {
    expect(
      repairOpportunityHeadline(LEGACY_2530, {
        metrics: { reactions: 900, comments: 10 },
      }),
    ).toContain("Ilan Asseo — 900 likes —");
  });

  test("is a no-op on current-format headlines", () => {
    const current =
      'Ilan Asseo — 2.3k likes — "The thing nobody tells you." — draft it?';
    expect(repairOpportunityHeadline(current, { metrics: { reactions: 2300 } })).toBe(
      current,
    );
  });

  test("is idempotent", () => {
    const payload = {
      author: "Ilan Asseo",
      metrics: { reactions: 2080, comments: 150 },
    };
    const once = repairOpportunityHeadline(LEGACY_2530, payload);
    expect(repairOpportunityHeadline(once, payload)).toBe(once);
  });
});

describe("readOpportunityHeadline", () => {
  test("repairs a stored legacy payload end to end", () => {
    expect(
      readOpportunityHeadline({
        headline: LEGACY_2530,
        author: "Ilan Asseo",
        metrics: { viral_score: 2530, reactions: 2080, comments: 150 },
      }),
    ).not.toMatch(/went \d/);
  });

  test("falls back when the payload has no headline", () => {
    expect(readOpportunityHeadline({})).toBe(OPPORTUNITY_HEADLINE_FALLBACK);
    expect(readOpportunityHeadline(null)).toBe(OPPORTUNITY_HEADLINE_FALLBACK);
    expect(readOpportunityHeadline({ headline: "   " })).toBe(
      OPPORTUNITY_HEADLINE_FALLBACK,
    );
  });

  test("no headline the panel renders can attribute a multiplier to a person", () => {
    const stored = [LEGACY_2530, LEGACY_VIRAL];
    for (const headline of stored) {
      const out = readOpportunityHeadline({
        headline,
        metrics: { reactions: 1200, comments: 30 },
      });
      expect(out).not.toMatch(/\bwent\b/);
    }
  });
});
