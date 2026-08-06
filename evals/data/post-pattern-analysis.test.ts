import { describe, expect, it } from "vitest";
import {
  analyzePostPatterns,
  classifyHook,
  hookPatternStats,
  hookTextOf,
  structureStats,
  type AnalyzablePost,
} from "@/lib/post-pattern-analysis";

// The classifier is rule-ordered on purpose: several rules can match one hook,
// and the tests below pin the PRECEDENCE, not just "does it match something".
// A refactor that reorders HOOK_RULES should fail here rather than quietly
// start reporting every stat-led question as a plain "question".

function post(id: string, body: string, engagement?: number): AnalyzablePost {
  return { id, body, engagement };
}

describe("hookTextOf", () => {
  it("takes the first non-empty line", () => {
    expect(hookTextOf("\n\nFirst real line\nSecond line")).toBe("First real line");
  });

  it("takes the first sentence when the opening line runs long", () => {
    // Otherwise a wall-of-text opener classifies on its tail.
    expect(hookTextOf("Short claim. Then a much longer trailing clause here.")).toBe(
      "Short claim.",
    );
  });

  it("returns empty string for a blank body", () => {
    expect(hookTextOf("   \n  ")).toBe("");
  });
});

describe("classifyHook — individual patterns", () => {
  const cases: Array<[string, string]> = [
    ["3 lessons from my first startup", "numbered_promise"],
    ["7 things I learned scaling to $1m", "numbered_promise"],
    ["92% of founders get this wrong", "stat_shock"],
    ["We burned $40k on ads last quarter", "stat_shock"],
    ["Unpopular opinion: standups are useless", "contrarian"],
    ["Stop writing cover letters", "contrarian"],
    ["I failed my first product launch", "personal_failure"],
    ["My biggest mistake as a manager", "personal_failure"],
    ["Confession: I don't actually read the docs", "confession"],
    ["After 10 years in sales, here is what matters", "authority_drop"],
    ["Here's what nobody tells you about hiring", "curiosity_gap"],
    ["What makes a good manager?", "question"],
    ["If you're a founder, read this", "direct_callout"],
    ["I walked into the office on a Tuesday", "story_setup"],
  ];
  for (const [body, expected] of cases) {
    it(`classifies "${body.slice(0, 38)}…" as ${expected}`, () => {
      expect(classifyHook(body)).toBe(expected);
    });
  }
});

describe("classifyHook — precedence between overlapping rules", () => {
  it("prefers the counted promise over the bare question", () => {
    expect(classifyHook("5 reasons your funnel leaks?")).toBe("numbered_promise");
  });

  it("prefers the statistic over the bare question", () => {
    expect(classifyHook("Did you know 80% of leads never convert?")).toBe(
      "stat_shock",
    );
  });

  it("prefers personal_failure over the broad story opener", () => {
    // Both match a first-person opener; the specific one must win.
    expect(classifyHook("I lost my biggest client last year")).toBe(
      "personal_failure",
    );
  });

  it("prefers authority_drop over the broad story opener", () => {
    expect(classifyHook("I've built three companies")).toBe("authority_drop");
  });

  it("does not read a mid-hook negation as a contrarian take", () => {
    // Regression: an unanchored /\bdon'?t\b/ matched any hook containing the
    // word, so this confession classified as contrarian. "Stop"/"Don't" is the
    // contrarian move only when it OPENS the hook.
    expect(classifyHook("Confession: I don't actually read the docs")).toBe(
      "confession",
    );
    expect(classifyHook("Don't hire a VP of Sales yet")).toBe("contrarian");
  });

  it("returns null rather than guessing when nothing matches", () => {
    // Folding this into a catch-all would overstate whichever bucket absorbed
    // it and hide genuinely novel openers.
    expect(classifyHook("Coffee.")).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(classifyHook("")).toBeNull();
  });
});

describe("hookPatternStats", () => {
  const posts = [
    post("a", "3 lessons from my first startup", 100),
    post("b", "5 ways to close faster", 200),
    post("c", "What makes a good manager?", 50),
    post("d", "Coffee."),
  ];

  it("counts posts per pattern and reports each share", () => {
    const stats = hookPatternStats(posts);
    const numbered = stats.find((s) => s.pattern === "numbered_promise")!;
    expect(numbered.posts).toBe(2);
    expect(numbered.share).toBeCloseTo(0.5);
  });

  it("surfaces unclassified as its own bucket", () => {
    const stats = hookPatternStats(posts);
    expect(stats.find((s) => s.pattern === "unclassified")?.posts).toBe(1);
  });

  it("averages engagement only over posts that reported it", () => {
    const stats = hookPatternStats(posts);
    expect(stats.find((s) => s.pattern === "numbered_promise")?.avg_engagement).toBe(
      150,
    );
    // "d" has no engagement number; a bucket with none reports null, not 0.
    expect(stats.find((s) => s.pattern === "unclassified")?.avg_engagement).toBeNull();
  });

  it("ranks by frequency, not by mean engagement", () => {
    // A single lucky post must not top the list and read as "this hook wins".
    const skewed = hookPatternStats([
      post("x", "What makes a good manager?", 10_000),
      post("y", "3 lessons from year one", 10),
      post("z", "5 ways to ship faster", 10),
    ]);
    expect(skewed[0].pattern).toBe("numbered_promise");
  });

  it("caps the examples it returns", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      post(`p${i}`, `${i + 2} lessons from the trenches`),
    );
    expect(hookPatternStats(many)[0].example_post_ids).toHaveLength(3);
  });

  it("handles an empty set without dividing by zero", () => {
    expect(hookPatternStats([])).toEqual([]);
  });
});

describe("structureStats", () => {
  it("reports the median length, not the mean", () => {
    // One long essay among short posts must not move the reported "typical".
    const stats = structureStats([
      post("a", "one two three"),
      post("b", "one two three"),
      post("c", Array.from({ length: 900 }, () => "word").join(" ")),
    ]);
    expect(stats.median_words).toBe(3);
  });

  it("measures how often the set uses lists", () => {
    const stats = structureStats([
      post("a", "Intro line\n\n- one\n- two\n- three"),
      post("b", "No list at all here"),
    ]);
    expect(stats.uses_list_rate).toBeCloseTo(0.5);
  });

  it("returns zeroed stats for an empty set", () => {
    expect(structureStats([])).toEqual({
      median_words: 0,
      median_paragraphs: 0,
      median_visual_lines: 0,
      uses_list_rate: 0,
      dominant_list_marker: null,
      post_script_rate: 0,
      median_hook_chars: 0,
    });
  });
});

describe("analyzePostPatterns", () => {
  it("ignores blank bodies in the analyzed count", () => {
    const result = analyzePostPatterns([
      post("a", "3 lessons from the trenches"),
      post("b", "   "),
    ]);
    expect(result.analyzed_posts).toBe(1);
  });

  it("returns a usable envelope for an empty set", () => {
    const result = analyzePostPatterns([]);
    expect(result.analyzed_posts).toBe(0);
    expect(result.hook_patterns).toEqual([]);
    expect(result.structure.median_words).toBe(0);
  });

  it("is deterministic across identical calls", () => {
    // The whole point of not using a model here: same input, same answer.
    const posts = [
      post("a", "3 lessons from my first startup", 10),
      post("b", "Unpopular opinion: standups are useless", 20),
      post("c", "What makes a good manager?", 30),
    ];
    expect(analyzePostPatterns(posts)).toEqual(analyzePostPatterns(posts));
  });

  it("reports mechanics measured from the bodies", () => {
    const result = analyzePostPatterns([
      post("a", "i think we ship too slowly. i said what i said."),
      post("b", "i keep seeing the same mistake. i want to name it."),
    ]);
    // Lowercase "i" is the tell this fingerprint exists to catch.
    expect(result.mechanics.lowercase_pronoun_i).toBeGreaterThan(0.5);
    expect(result.mechanics.sample_size).toBe(2);
  });
});
