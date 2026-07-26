import { describe, expect, test } from "vitest";
import {
  diverseCreatorResults,
  diversityCandidateLimit,
} from "@/lib/mcp/creator-diversity";

type Candidate = { id: string; account_id: string; score: number };

describe("MCP creator diversity", () => {
  test("preserves the strongest same-creator results before adding diversity", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "a2", account_id: "a", score: 99 },
      { id: "b1", account_id: "b", score: 98 },
      { id: "c1", account_id: "c", score: 97 },
      { id: "b2", account_id: "b", score: 96 },
    ];

    expect(
      diverseCreatorResults(candidates, 4, (post) => post.account_id).map(
        (post) => post.id,
      ),
    ).toEqual(["a1", "a2", "b1", "c1"]);
  });

  test("falls back to additional relevant posts when alternatives run out", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "a2", account_id: "a", score: 99 },
      { id: "a3", account_id: "a", score: 98 },
      { id: "b1", account_id: "b", score: 97 },
    ];

    expect(
      diverseCreatorResults(candidates, 4, (post) => post.account_id).map(
        (post) => post.id,
      ),
    ).toEqual(["a1", "a2", "b1", "a3"]);
  });

  test("does not promote a distant alternative above the top two results", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "a2", account_id: "a", score: 99 },
      { id: "a3", account_id: "a", score: 98 },
      { id: "a4", account_id: "a", score: 97 },
      { id: "b1", account_id: "b", score: 20 },
    ];

    expect(
      diverseCreatorResults(candidates, 2, (post) => post.account_id).map(
        (post) => post.id,
      ),
    ).toEqual(["a1", "a2"]);
  });

  test("caps a creator at two results when relevant alternatives exist", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "a2", account_id: "a", score: 99 },
      { id: "a3", account_id: "a", score: 98 },
      { id: "b1", account_id: "b", score: 97 },
      { id: "c1", account_id: "c", score: 96 },
    ];

    expect(
      diverseCreatorResults(candidates, 4, (post) => post.account_id).map(
        (post) => post.id,
      ),
    ).toEqual(["a1", "a2", "b1", "c1"]);
  });

  test("preserves relevance order when every candidate has a unique creator", () => {
    const candidates: Candidate[] = [
      { id: "a1", account_id: "a", score: 100 },
      { id: "b1", account_id: "b", score: 99 },
      { id: "c1", account_id: "c", score: 98 },
    ];

    expect(
      diverseCreatorResults(candidates, 3, (post) => post.account_id),
    ).toEqual(candidates);
  });

  test("fetches a bounded relevance-ranked candidate pool", () => {
    expect(diversityCandidateLimit(10)).toBe(40);
    expect(diversityCandidateLimit(50)).toBe(200);
    expect(diversityCandidateLimit(1)).toBe(4);
  });
});
