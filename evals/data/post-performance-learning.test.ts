import { describe, expect, test } from "vitest";
import {
  POST_PERFORMANCE_BLOCK_CHARS_MAX,
  computePostPerformanceLearnings,
  renderPostPerformanceBlock,
  type PostPerformancePost,
} from "@/lib/post-performance-learning";

const LONG_HOOK = "L".repeat(90);
const shortHookBody = `Quick hook.\n\n${"Body text. ".repeat(10)}`;
const longHookBody = `${LONG_HOOK}\n\n${"Body text. ".repeat(10)}`;
const listBody = `${LONG_HOOK}\n\nIntro line.\n\n- one\n- two\n- three`;
const questionBody = `${LONG_HOOK}\n\nBody text.\n\nWhat do you think?`;
const longBody = `${LONG_HOOK}\n\n${"x".repeat(1_600)}`;

function post(
  body: string,
  options: {
    rate?: number;
    impressions?: number | null;
    hasMedia?: boolean;
  } = {},
): PostPerformancePost {
  const impressions =
    options.impressions === undefined ? 1_000 : options.impressions;
  const rate = options.rate ?? 0.03;
  const measurable = typeof impressions === "number" && impressions > 0;
  return {
    body,
    hasMedia: options.hasMedia ?? false,
    impressions,
    likes: measurable ? rate * (impressions as number) : 5,
    comments: 0,
    shares: 0,
  };
}

describe("computePostPerformanceLearnings", () => {
  test("returns nothing below the minimum measured-post gate", () => {
    const learnings = computePostPerformanceLearnings([
      ...Array.from({ length: 4 }, () =>
        post(shortHookBody, { rate: 0.05 }),
      ),
      ...Array.from({ length: 3 }, () => post(longHookBody, { rate: 0.01 })),
    ]);

    expect(learnings).toEqual([]);
  });

  test("compares a bucket's median engagement rate to the overall median", () => {
    const learnings = computePostPerformanceLearnings([
      ...Array.from({ length: 4 }, () =>
        post(shortHookBody, { rate: 0.05 }),
      ),
      ...Array.from({ length: 4 }, () => post(longHookBody, { rate: 0.01 })),
    ]);

    expect(learnings).toEqual([
      "Posts with a hook under 80 characters earned 1.7x your median engagement rate (4 posts)",
    ]);
  });

  test("flags underperforming buckets with the same median math", () => {
    const learnings = computePostPerformanceLearnings([
      ...Array.from({ length: 4 }, () =>
        post(longHookBody, { rate: 0.01, hasMedia: true }),
      ),
      ...Array.from({ length: 4 }, () => post(longHookBody, { rate: 0.05 })),
    ]);

    expect(learnings).toEqual([
      "Posts with media attached earned only 0.3x your median engagement rate (4 posts)",
    ]);
  });

  test("requires at least three measured posts in a bucket", () => {
    const learnings = computePostPerformanceLearnings([
      ...Array.from({ length: 6 }, () => post(longHookBody, { rate: 0.03 })),
      post(longHookBody, { rate: 0.001, hasMedia: true }),
      post(longHookBody, { rate: 0.001, hasMedia: true }),
    ]);

    expect(learnings).toEqual([]);
  });

  test("skips posts with null or zero impressions", () => {
    expect(
      computePostPerformanceLearnings([
        post(shortHookBody, { impressions: 0 }),
        post(shortHookBody, { impressions: null }),
      ]),
    ).toEqual([]);

    const valid = [
      ...Array.from({ length: 4 }, () =>
        post(shortHookBody, { rate: 0.05 }),
      ),
      ...Array.from({ length: 4 }, () => post(longHookBody, { rate: 0.01 })),
    ];
    // The unmeasurable extras must not join any bucket or move the median.
    const learnings = computePostPerformanceLearnings([
      ...valid,
      post(shortHookBody, { rate: 0.5, impressions: 0 }),
      post(longHookBody, { rate: 0.5, impressions: null, hasMedia: true }),
    ]);

    expect(learnings).toEqual([
      "Posts with a hook under 80 characters earned 1.7x your median engagement rate (4 posts)",
    ]);
  });

  test("applies the lift band: 1.5x emits, inside the band does not", () => {
    const base = Array.from({ length: 8 }, () =>
      post(longHookBody, { rate: 0.0625 }),
    );

    expect(
      computePostPerformanceLearnings([
        ...base,
        ...Array.from({ length: 3 }, () =>
          post(shortHookBody, { rate: 0.09375 }),
        ),
      ]),
    ).toEqual([
      "Posts with a hook under 80 characters earned 1.5x your median engagement rate (3 posts)",
    ]);

    expect(
      computePostPerformanceLearnings([
        ...base,
        ...Array.from({ length: 3 }, () =>
          post(shortHookBody, { rate: 0.078125 }),
        ),
      ]),
    ).toEqual([]);
  });

  test("caps findings at four, keeping the strongest effects", () => {
    const learnings = computePostPerformanceLearnings([
      ...Array.from({ length: 16 }, () => post(longHookBody, { rate: 0.02 })),
      ...Array.from({ length: 3 }, () => post(shortHookBody, { rate: 0.12 })),
      ...Array.from({ length: 3 }, () => post(listBody, { rate: 0.11 })),
      ...Array.from({ length: 3 }, () => post(questionBody, { rate: 0.1 })),
      ...Array.from({ length: 3 }, () =>
        post(longHookBody, { rate: 0.09, hasMedia: true }),
      ),
      ...Array.from({ length: 3 }, () => post(longBody, { rate: 0.08 })),
    ]);

    expect(learnings).toEqual([
      "Posts with a hook under 80 characters earned 6x your median engagement rate (3 posts)",
      "Posts with a 3+ item list earned 5.5x your median engagement rate (3 posts)",
      "Posts ending with a question CTA earned 5x your median engagement rate (3 posts)",
      "Posts with media attached earned 4.5x your median engagement rate (3 posts)",
    ]);
  });
});

describe("renderPostPerformanceBlock", () => {
  test("empty learnings render an empty block", () => {
    expect(renderPostPerformanceBlock([])).toBe("");
  });

  test("renders findings as soft guidance", () => {
    const block = renderPostPerformanceBlock([
      "Posts with a hook under 80 characters earned 2.8x your median engagement rate (5 posts)",
    ]);

    expect(block).toContain("Your own published posts' measured engagement");
    expect(block).toContain("soft guidance");
    expect(block).toContain(
      "- Posts with a hook under 80 characters earned 2.8x your median engagement rate (5 posts)",
    );
  });

  test("drops trailing findings to stay inside the char cap", () => {
    const learnings = Array.from(
      { length: 12 },
      (_, index) => `Finding ${index}: ${"x".repeat(220)}`,
    );
    const block = renderPostPerformanceBlock(learnings);

    expect(block.length).toBeLessThanOrEqual(POST_PERFORMANCE_BLOCK_CHARS_MAX);
    expect(block).toContain("Finding 0");
    expect(block).not.toContain("Finding 11");
  });
});
