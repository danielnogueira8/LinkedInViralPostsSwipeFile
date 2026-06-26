import { describe, test, expect } from "vitest";
import {
  extractActivityId,
  extractUrnFromUrl,
  authorHandleFromUrl,
  authorHandleFromProfileUrl,
  postedAtFromLinkedInId,
} from "@/lib/linkedin-url";
import { score, meetsThreshold, median, decideRelativeViral } from "@/lib/viral";
import { classifyPost, normalizePostType } from "@/lib/post-type";
import { parseDayStart, parseDayEnd, sinceCutoff, normalizeProfileUrl } from "@/lib/mcp/util";

// ---------------------------------------------------------------------------
// Unit tests for the pure, non-chat logic — the parsing / scoring / classifying
// functions where a bug is silent and high-impact. None of these touch the DB,
// network, or a model, so they run in the default hermetic suite.
// ---------------------------------------------------------------------------

describe("linkedin-url: URN / activity-id extraction", () => {
  test("canonical /feed/update/ activity URN", () => {
    const url = "https://www.linkedin.com/feed/update/urn:li:activity:7427236756741287936/";
    expect(extractUrnFromUrl(url)).toEqual({ id: "7427236756741287936", type: "activity" });
    expect(extractActivityId(url)).toBe("7427236756741287936");
  });

  test("share URN (harvestapi feed url)", () => {
    expect(extractUrnFromUrl("https://www.linkedin.com/feed/update/urn:li:share:7462833159877922817"))
      .toEqual({ id: "7462833159877922817", type: "share" });
  });

  test("ugcPost URN", () => {
    expect(extractUrnFromUrl("https://www.linkedin.com/feed/update/urn:li:ugcPost:7427236756741287936"))
      .toEqual({ id: "7427236756741287936", type: "ugcPost" });
  });

  test("pretty /posts/ slug — id is the digit-run before the 4-char suffix", () => {
    const url =
      "https://www.linkedin.com/posts/naman-jain-458946388_growth-tips-activity-7427236755713441792-B2kj?utm_source=share";
    expect(extractActivityId(url)).toBe("7427236755713441792");
  });

  test("activity URN wins when both an activity and a slug id are present", () => {
    // A canonical URL with a trailing tracking slug must resolve to the activity id,
    // not a digit-run elsewhere in the string.
    const url = "https://www.linkedin.com/feed/update/urn:li:activity:7427236756741287936/?foo=bar-123456789012345-xyz";
    expect(extractUrnFromUrl(url)?.type).toBe("activity");
    expect(extractActivityId(url)).toBe("7427236756741287936");
  });

  test("non-LinkedIn / unparseable URLs return null (no false positives)", () => {
    expect(extractActivityId("https://example.com/foo")).toBeNull();
    expect(extractActivityId("not a url")).toBeNull();
    expect(extractActivityId("")).toBeNull();
    // A digit run that's too short to be an activity id must not match.
    expect(extractActivityId("https://www.linkedin.com/posts/x_y-12345-ab")).toBeNull();
  });
});

describe("linkedin-url: author handle extraction", () => {
  test("from a /posts/ slug (segment before the first underscore)", () => {
    expect(
      authorHandleFromUrl(
        "https://www.linkedin.com/posts/naman-jain-458946388_growth-activity-7427236755713441792-B2kj",
      ),
    ).toBe("naman-jain-458946388");
  });

  test("from a /in/ profile url, lowercased", () => {
    expect(authorHandleFromProfileUrl("https://www.linkedin.com/in/Naman-Jain/")).toBe("naman-jain");
  });

  test("returns null for a url with no handle", () => {
    expect(authorHandleFromProfileUrl("https://www.linkedin.com/feed/")).toBeNull();
  });
});

describe("linkedin-url: postedAtFromLinkedInId (Snowflake decode)", () => {
  test("decodes a real activity id to a plausible 2024+ timestamp", () => {
    // 7427236756741287936 → high bits are a Unix-ms timestamp.
    const iso = postedAtFromLinkedInId("7427236756741287936");
    expect(iso).not.toBeNull();
    const year = new Date(iso as string).getUTCFullYear();
    expect(year).toBeGreaterThanOrEqual(2024);
    expect(year).toBeLessThanOrEqual(2026);
  });

  test("rejects malformed / out-of-range ids", () => {
    expect(postedAtFromLinkedInId(null)).toBeNull();
    expect(postedAtFromLinkedInId(undefined)).toBeNull();
    expect(postedAtFromLinkedInId("abc")).toBeNull();
    expect(postedAtFromLinkedInId("123")).toBeNull(); // too short (<15 digits)
    expect(postedAtFromLinkedInId("1")).toBeNull();
    // A 15-digit number that decodes to before 2003 → out of sanity window → null.
    expect(postedAtFromLinkedInId("000000000000001")).toBeNull();
  });

  test("decode is monotonic — a larger id is a later timestamp", () => {
    const a = postedAtFromLinkedInId("7427236755713441792");
    const b = postedAtFromLinkedInId("7427236756741287936");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(new Date(b as string).getTime()).toBeGreaterThan(new Date(a as string).getTime());
  });
});

describe("viral: score + flat threshold", () => {
  test("score weights comments 3x and reposts 5x", () => {
    expect(score(10, 2, 1)).toBe(10 + 6 + 5); // 21
    expect(score(0, 0, 0)).toBe(0);
  });

  test("meetsThreshold is an OR of reactions and comments", () => {
    const t = { min_reactions: 200, min_comments: 50 };
    expect(meetsThreshold(200, 0, t)).toBe(true); // reactions alone
    expect(meetsThreshold(0, 50, t)).toBe(true); // comments alone
    expect(meetsThreshold(199, 49, t)).toBe(false); // neither
  });
});

describe("viral: median", () => {
  test("odd length → middle element", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  test("even length → average of the two middle elements", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  test("empty → null", () => {
    expect(median([])).toBeNull();
  });
  test("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("viral: decideRelativeViral", () => {
  const flat = { min_reactions: 200, min_comments: 50 };
  const config = { minHistory: 5, window: 15, multiplier: 1.3, absoluteFloor: 50 };

  test("cold start (too little history) → flat fallback", () => {
    const d = decideRelativeViral({
      score: 1000,
      reactions: 250,
      comments: 0,
      priorScores: [10, 20], // < minHistory
      flatThresholds: flat,
      config,
    });
    expect(d.basis).toBe("flat_fallback");
    expect(d.viral).toBe(true); // 250 reactions clears the flat threshold
    expect(d.baseline).toBeNull();
  });

  test("enough history + clears multiplier × median → relative viral", () => {
    const d = decideRelativeViral({
      score: 200,
      reactions: 0,
      comments: 0,
      priorScores: [100, 100, 100, 100, 100], // median 100, ×1.3 = 130
      flatThresholds: flat,
      config,
    });
    expect(d.basis).toBe("relative");
    expect(d.baseline).toBe(100);
    expect(d.viral).toBe(true); // 200 ≥ 130
  });

  test("enough history but below multiplier × median → not viral", () => {
    const d = decideRelativeViral({
      score: 120,
      reactions: 0,
      comments: 0,
      priorScores: [100, 100, 100, 100, 100], // ×1.3 = 130
      flatThresholds: flat,
      config,
    });
    expect(d.basis).toBe("relative");
    expect(d.viral).toBe(false); // 120 < 130
  });

  test("below the absolute floor is never viral, even vs a tiny baseline", () => {
    const d = decideRelativeViral({
      score: 40, // < floor 50
      reactions: 0,
      comments: 0,
      priorScores: [1, 1, 1, 1, 1], // tiny median; 40 would beat ×1.3 = 1.3
      flatThresholds: flat,
      config,
    });
    expect(d.basis).toBe("below_floor");
    expect(d.viral).toBe(false);
  });
});

describe("post-type: classifyPost", () => {
  test("plain post → regular", () => {
    expect(classifyPost("Here's what I learned shipping 10 features this quarter.").post_type).toBe("regular");
  });

  test("quoted-keyword CTA → lead_magnet", () => {
    expect(classifyPost("Want my playbook? Comment 'SCALE' below and I'll send it.").post_type).toBe("lead_magnet");
  });

  test("I'll DM it → lead_magnet", () => {
    expect(classifyPost("Drop a comment and I'll DM you the link.").post_type).toBe("lead_magnet");
  });

  test("must be connected gating → lead_magnet", () => {
    expect(classifyPost("Comment below — but you must be connected for me to send it.").post_type).toBe("lead_magnet");
  });

  test("all-caps CTA keyword → lead_magnet, but stop-listed words don't false-positive", () => {
    expect(classifyPost("Comment GUIDE and I'll send the template.").post_type).toBe("lead_magnet");
    // "Drop ONE thing..." must NOT be flagged (ONE is stop-listed).
    expect(classifyPost("Drop ONE thing you'd change about your onboarding.").post_type).toBe("regular");
    // "Drop the act" must NOT match Pattern A (no quotes, lowercase).
    expect(classifyPost("Time to drop the act and ship.").post_type).toBe("regular");
  });

  test("null / empty text → regular", () => {
    expect(classifyPost(null).post_type).toBe("regular");
    expect(classifyPost("").post_type).toBe("regular");
  });

  test("normalizePostType guards untrusted input", () => {
    expect(normalizePostType("regular")).toBe("regular");
    expect(normalizePostType("lead_magnet")).toBe("lead_magnet");
    expect(normalizePostType("garbage")).toBeNull();
    expect(normalizePostType(null)).toBeNull();
  });
});

describe("mcp/util: date parsing", () => {
  test("parseDayStart / parseDayEnd bracket the full UTC day", () => {
    expect(parseDayStart("2026-06-25")).toBe("2026-06-25T00:00:00.000Z");
    expect(parseDayEnd("2026-06-25")).toBe("2026-06-25T23:59:59.999Z");
  });

  test("malformed dates → null (not an Invalid Date string)", () => {
    expect(parseDayStart("2026/06/25")).toBeNull(); // wrong separator
    expect(parseDayStart("not-a-date")).toBeNull();
    expect(parseDayStart(undefined)).toBeNull();
    expect(parseDayEnd("2026-13-99")).toBeNull(); // regex passes shape, Date rejects
  });

  test("sinceCutoff maps the enum to a past ISO timestamp; junk → null", () => {
    expect(sinceCutoff(undefined)).toBeNull();
    expect(sinceCutoff("99d")).toBeNull();
    const since7 = sinceCutoff("7d");
    expect(since7).not.toBeNull();
    // ~7 days ago, within a generous tolerance.
    const ageMs = Date.now() - new Date(since7 as string).getTime();
    expect(ageMs).toBeGreaterThan(6.5 * 24 * 3600 * 1000);
    expect(ageMs).toBeLessThan(7.5 * 24 * 3600 * 1000);
  });

  test("normalizeProfileUrl lowercases the handle and drops query/fragment", () => {
    expect(normalizeProfileUrl("https://www.linkedin.com/in/Naman-Jain/?trk=abc"))
      .toBe("https://www.linkedin.com/in/naman-jain");
    expect(normalizeProfileUrl("https://example.com/foo")).toBeNull();
  });
});
