import { describe, expect, test } from "vitest";
import {
  comparableRelevance,
  diverseCreatorResults,
  diversityCandidateLimit,
} from "@/lib/mcp/creator-diversity";

type Candidate = { id: string; account_id: string; score: number };

describe("MCP creator diversity", () => {
  test("prioritizes unique creators before repeated creators", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "a2", account_id: "a", score: 99 },
      { id: "b1", account_id: "b", score: 98 },
      { id: "c1", account_id: "c", score: 97 },
      { id: "b2", account_id: "b", score: 96 },
    ];

    expect(
      diverseCreatorResults(
        candidates,
        4,
        (post) => post.account_id,
        (best, alternative) =>
          comparableRelevance(best.score, alternative.score, {
            ascending: false,
            kind: "number",
          }),
      ).map((post) => post.id),
    ).toEqual(["a1", "b1", "c1", "a2"]);
  });

  test("falls back to additional relevant posts when alternatives run out", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "a2", account_id: "a", score: 99 },
      { id: "a3", account_id: "a", score: 98 },
      { id: "b1", account_id: "b", score: 97 },
    ];

    expect(
      diverseCreatorResults(
        candidates,
        4,
        (post) => post.account_id,
        (best, alternative) =>
          comparableRelevance(best.score, alternative.score, {
            ascending: false,
            kind: "number",
          }),
      ).map((post) => post.id),
    ).toEqual(["a1", "b1", "a2", "a3"]);
  });

  test("does not trade a dramatically stronger result for diversity", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "a2", account_id: "a", score: 99 },
      { id: "a3", account_id: "a", score: 98 },
      { id: "a4", account_id: "a", score: 97 },
      { id: "b1", account_id: "b", score: 20 },
    ];

    expect(
      diverseCreatorResults(
        candidates,
        2,
        (post) => post.account_id,
        (best, alternative) =>
          comparableRelevance(best.score, alternative.score, {
            ascending: false,
            kind: "number",
          }),
      ).map((post) => post.id),
    ).toEqual(["a1", "a2"]);
  });

  test("emits every available unique creator before a repeat", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "a2", account_id: "a", score: 99 },
      { id: "a3", account_id: "a", score: 98 },
      { id: "b1", account_id: "b", score: 97 },
      { id: "c1", account_id: "c", score: 96 },
    ];

    expect(
      diverseCreatorResults(
        candidates,
        4,
        (post) => post.account_id,
        (best, alternative) =>
          comparableRelevance(best.score, alternative.score, {
            ascending: false,
            kind: "number",
          }),
      ).map((post) => post.id),
    ).toEqual(["a1", "b1", "c1", "a2"]);
  });

  test("preserves relevance order when every candidate has a unique creator", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "b1", account_id: "b", score: 99 },
      { id: "c1", account_id: "c", score: 98 },
    ];

    expect(
      diverseCreatorResults(
        candidates,
        3,
        (post) => post.account_id,
        () => true,
      ),
    ).toEqual(candidates);
  });

  test("fetches a bounded relevance-ranked candidate pool", () => {
    expect(diversityCandidateLimit(10)).toBe(40);
    expect(diversityCandidateLimit(50)).toBe(200);
    expect(diversityCandidateLimit(1)).toBe(4);
  });

  test("compares numeric relevance in both sort directions", () => {
    expect(
      comparableRelevance(100, 85, { ascending: false, kind: "number" }),
    ).toBe(true);
    expect(
      comparableRelevance(100, 130, { ascending: true, kind: "number" }),
    ).toBe(false);
  });

  test("uses a real time window for posted-date relevance", () => {
    expect(
      comparableRelevance("2026-07-26", "2026-07-20", {
        ascending: false,
        kind: "posted",
      }),
    ).toBe(true);
    expect(
      comparableRelevance("2026-07-26", "2025-07-26", {
        ascending: false,
        kind: "posted",
      }),
    ).toBe(false);
    expect(
      comparableRelevance("2025-07-26", "2026-07-26", {
        ascending: true,
        kind: "posted",
      }),
    ).toBe(false);
  });
});
