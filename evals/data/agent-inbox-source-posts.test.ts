import { describe, expect, test } from "vitest";
import {
  dedupeSourcePostEvidence,
  rankSourcePostEvidence,
  sourcePostEvidenceFromCandidate,
  type AgentInboxSourcePostCandidate,
} from "@/lib/agent-inbox/evidence";

const LONG_POST = Array.from(
  { length: 48 },
  (_, index) => `The source post beat ${index + 1} explains a useful pattern.`,
).join(" ");

function candidate(
  overrides: Partial<AgentInboxSourcePostCandidate> = {},
): AgentInboxSourcePostCandidate {
  return {
    id: "post-1",
    origin: "swipe",
    text: LONG_POST,
    authorName: "Alex Founder",
    url: "https://linkedin.com/posts/post-1",
    publishedAt: "2026-07-30T10:00:00.000Z",
    savedAt: null,
    reactions: 120,
    comments: 24,
    ...overrides,
  };
}

describe("agent inbox source-post evidence", () => {
  test("marks a real swipe-file post as inspiration, never as a user anchor", () => {
    const entry = sourcePostEvidenceFromCandidate(candidate());

    expect(entry).toMatchObject({
      kind: "source_post",
      role: "inspiration",
      sourceOrigin: "swipe",
      ref: "post-1",
      authorName: "Alex Founder",
    });
  });

  test("drops source material that is too short to expose a reusable structure", () => {
    expect(
      sourcePostEvidenceFromCandidate(candidate({ text: "A short post." })),
    ).toBeNull();
  });

  test("prefers saved bookmarks when the same post exists in both pools", () => {
    const ranked = rankSourcePostEvidence(
      [
        sourcePostEvidenceFromCandidate(candidate())!,
        sourcePostEvidenceFromCandidate(
          candidate({
            origin: "bookmark",
            id: "bookmark-1",
            savedAt: "2026-07-31T10:00:00.000Z",
          }),
        )!,
      ],
      new Date("2026-08-01T10:00:00.000Z"),
      [],
    );

    expect(ranked[0]).toMatchObject({
      role: "inspiration",
      sourceOrigin: "bookmark",
      ref: "bookmark-1",
    });
  });

  test("deduplicates by canonical URL while preserving the highest-ranked source", () => {
    const entries = [
      sourcePostEvidenceFromCandidate(
        candidate({
          origin: "bookmark",
          id: "bookmark-1",
          savedAt: "2026-07-31T10:00:00.000Z",
        }),
      )!,
      sourcePostEvidenceFromCandidate(candidate())!,
    ];

    expect(dedupeSourcePostEvidence(entries)).toHaveLength(1);
    expect(dedupeSourcePostEvidence(entries)[0]?.sourceOrigin).toBe(
      "bookmark",
    );
  });
});
