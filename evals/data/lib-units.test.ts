import { describe, test, expect } from "vitest";
import {
  extractActivityId,
  extractUrnFromUrl,
  authorHandleFromUrl,
  authorHandleFromProfileUrl,
  postedAtFromLinkedInId,
  nameFromOgTitle,
  displayNameFromHandle,
} from "@/lib/linkedin-url";
import { score, meetsThreshold, median, decideRelativeViral } from "@/lib/viral";
import { classifyPost, normalizePostType } from "@/lib/post-type";
import { parseDayStart, parseDayEnd, sinceCutoff, normalizeProfileUrl } from "@/lib/mcp/util";
import {
  extractHookHeuristic,
  qualifiesForHookLibrary,
  normalizeHookForDedupe,
  type HookCandidate,
} from "@/lib/hooks";

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

// Auto-fetching a creator's NAME from their profile URL (free, no Apify): the
// name comes from the profile's og:title, which LinkedIn serves in a few
// shapes. nameFromOgTitle normalizes them; displayNameFromHandle is the
// slug-derived fallback when the fetch is blocked.
describe("linkedin-url: nameFromOgTitle (name from a profile og:title)", () => {
  test("strips the ' - <headline> | LinkedIn' tail, keeps the name", () => {
    expect(
      nameFromOgTitle("Justin Welsh - The Diversified Solopreneur | LinkedIn"),
    ).toBe("Justin Welsh");
  });

  test("strips a bare '| LinkedIn' suffix", () => {
    expect(nameFromOgTitle("Lara Acosta | LinkedIn")).toBe("Lara Acosta");
  });

  test("a plain name with no suffix passes through", () => {
    expect(nameFromOgTitle("Naman Jain")).toBe("Naman Jain");
  });

  test("handles an en-dash separator before LinkedIn", () => {
    expect(nameFromOgTitle("Hatice Kamran – LinkedIn")).toBe("Hatice Kamran");
  });

  test("keeps a hyphenated name intact (only ' - ' with spaces splits)", () => {
    // A real hyphenated surname must survive; only the ' - headline' join splits.
    expect(nameFromOgTitle("Jean-Paul Sartre | LinkedIn")).toBe(
      "Jean-Paul Sartre",
    );
  });

  test("empty / absurdly long → null (so the caller falls back to the slug)", () => {
    expect(nameFromOgTitle("")).toBeNull();
    expect(nameFromOgTitle("| LinkedIn")).toBeNull();
    expect(nameFromOgTitle("x".repeat(200))).toBeNull();
  });

  test("displayNameFromHandle is the slug fallback (drops the numeric tail)", () => {
    expect(displayNameFromHandle("naman-jain-458946388")).toBe("Naman Jain");
    expect(displayNameFromHandle("justinwelsh")).toBe("Justinwelsh");
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

describe("hooks: extractHookHeuristic", () => {
  test("cuts at the first paragraph break", () => {
    const text = "I quit my job at Google.\n\nHere's what nobody tells you about leaving big tech.";
    expect(extractHookHeuristic(text)).toBe("I quit my job at Google.");
  });

  test("a long single opener (>120 chars) is the whole hook, second sentence not appended", () => {
    const long =
      "Three years ago I was completely broke, sleeping on a friend's couch, and convinced I would never build anything that mattered in my entire life.";
    const second = "\nThen one decision changed everything.";
    const hook = extractHookHeuristic(long + second);
    expect(hook).toBe(long); // first piece already ≥120 chars → stop
  });

  test("two short sentences are joined", () => {
    const hook = extractHookHeuristic("Stop chasing leads.\nStart attracting them.");
    expect(hook).toBe("Stop chasing leads. Start attracting them.");
  });

  test("rejects an unusable hook (too short / mostly emoji) → null", () => {
    expect(extractHookHeuristic("🔥🔥🔥")).toBeNull();
    expect(extractHookHeuristic("Hi all")).toBeNull(); // < 12 chars
    expect(extractHookHeuristic(null)).toBeNull();
    expect(extractHookHeuristic("   ")).toBeNull();
  });

  test("a long opener with no early terminator is rejected as truncated → null", () => {
    // The first chunk fills to the char cap and ends mid-word with no sentence
    // terminator, which isUsableHook treats as truncated. The heuristic bails
    // (caller falls back to Claude) rather than returning a chopped fragment.
    // This holds whether the input has no terminators at all...
    expect(extractHookHeuristic("word ".repeat(200))).toBeNull();
    // ...or a single very long sentence whose period sits past the chunk cap.
    const longSentence =
      "I learned this the hard way after " +
      "burning through a lot of cash and time ".repeat(10) +
      "and finally figuring it out.";
    expect(longSentence.length).toBeGreaterThan(360);
    expect(extractHookHeuristic(longSentence)).toBeNull();
  });

  test("any returned hook never exceeds the max length", () => {
    // Across a range of inputs, a non-null hook is always ≤280 chars (the cap).
    for (const input of [
      "Stop chasing leads.\nStart attracting them and grow.",
      "I quit my job at Google.\n\nLong body follows here.",
      "Short punchy contrarian opener that runs about a hundred and ten characters before its first hard stop here.",
    ]) {
      const h = extractHookHeuristic(input);
      if (h !== null) expect(h.length).toBeLessThanOrEqual(280);
    }
  });
});

describe("hooks: qualifiesForHookLibrary", () => {
  const t = { regularMinReactions: 300, leadMagnetMinComments: 200, normMultiplier: 1.5 };
  const base: HookCandidate = {
    post_type: "regular",
    reactions: 0,
    comments: 0,
    viral_score: 0,
    viral_basis: null,
    baseline_score: null,
  };

  test("lead magnet: gated on comments only, ignores reactions + norm", () => {
    expect(qualifiesForHookLibrary({ ...base, post_type: "lead_magnet", comments: 200, reactions: 0 }, t)).toBe(true);
    expect(qualifiesForHookLibrary({ ...base, post_type: "lead_magnet", comments: 199 }, t)).toBe(false);
  });

  test("regular: below the reaction floor → rejected", () => {
    expect(qualifiesForHookLibrary({ ...base, reactions: 299 }, t)).toBe(false);
  });

  test("regular with a relative baseline: must beat normMultiplier × baseline", () => {
    // reactions clear the floor; viral_score 200 vs 1.5 × 100 = 150 → passes
    expect(
      qualifiesForHookLibrary(
        { ...base, reactions: 500, viral_basis: "relative", baseline_score: 100, viral_score: 200 },
        t,
      ),
    ).toBe(true);
    // viral_score 120 < 150 → rejected despite clearing the reaction floor
    expect(
      qualifiesForHookLibrary(
        { ...base, reactions: 500, viral_basis: "relative", baseline_score: 100, viral_score: 120 },
        t,
      ),
    ).toBe(false);
  });

  test("regular, new creator (flat_fallback / no baseline): reaction floor alone carries it", () => {
    expect(
      qualifiesForHookLibrary({ ...base, reactions: 500, viral_basis: "flat_fallback", baseline_score: null }, t),
    ).toBe(true);
    // Legacy row (null basis) above the floor also passes — no norm gate to apply.
    expect(qualifiesForHookLibrary({ ...base, reactions: 500, viral_basis: null }, t)).toBe(true);
  });

  test("null post_type defaults to regular", () => {
    expect(qualifiesForHookLibrary({ ...base, post_type: null, reactions: 500 }, t)).toBe(true);
    expect(qualifiesForHookLibrary({ ...base, post_type: null, reactions: 100 }, t)).toBe(false);
  });
});

describe("hooks: normalizeHookForDedupe", () => {
  test("casing / punctuation / emoji collapse to the same key", () => {
    const a = normalizeHookForDedupe("Stop chasing leads! 🔥");
    const b = normalizeHookForDedupe("stop chasing leads");
    expect(a).toBe(b);
    expect(a).toBe("stop chasing leads");
  });

  test("em-dashes, arrows, and extra whitespace are normalized away", () => {
    expect(normalizeHookForDedupe("Growth → is   a  system—not luck.")).toBe("growth is a systemnot luck");
  });

  test("two hooks differing only by trailing punctuation are equal", () => {
    expect(normalizeHookForDedupe("Who else?")).toBe(normalizeHookForDedupe("who else"));
  });
});
