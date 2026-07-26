import { describe, expect, test } from "vitest";
import {
  diverseCreatorResults,
  diversityCandidateLimit,
} from "@/lib/mcp/creator-diversity";

type Candidate = { id: string; account_id: string; score: number };

describe("MCP creator diversity", () => {
  test("returns one result per creator before repeating a creator", () => {
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
      diverseCreatorResults(candidates, 4, (post) => post.account_id).map(
        (post) => post.id,
      ),
    ).toEqual(["a1", "b1", "a2", "a3"]);
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
