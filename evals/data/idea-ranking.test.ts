import { describe, test, expect } from "vitest";
import { rankIdeaPosts } from "@/lib/agent/tools";

// rankIdeaPosts keeps the query's (recency-windowed, reactions-desc) order but
// partitions un-used posts ahead of already-drafted ones, and tags each with
// already_used — so the agent leads with fresh ideas and can skip repeats.
describe("rankIdeaPosts — least-mentioned first, stable within groups", () => {
  const posts = [
    { id: "a", reactions: 500 },
    { id: "b", reactions: 400 },
    { id: "c", reactions: 300 },
    { id: "d", reactions: 200 },
  ];

  test("un-used posts come before already-used ones", () => {
    const used = new Set(["a", "c"]); // a + c already drafted from
    const out = rankIdeaPosts(posts, used);
    expect(out.map((p) => p.id)).toEqual(["b", "d", "a", "c"]);
  });

  test("annotates each post with already_used", () => {
    const out = rankIdeaPosts(posts, new Set(["a"]));
    const byId = Object.fromEntries(out.map((p) => [p.id, p.already_used]));
    expect(byId).toEqual({ a: true, b: false, c: false, d: false });
  });

  test("preserves reactions order within each group (stable)", () => {
    // b (400) before d (200) among un-used; a (500) before c (300) among used.
    const out = rankIdeaPosts(posts, new Set(["a", "c"]));
    expect(out.map((p) => p.id)).toEqual(["b", "d", "a", "c"]);
  });

  test("no used ids → order unchanged, all already_used false", () => {
    const out = rankIdeaPosts(posts, new Set());
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.every((p) => p.already_used === false)).toBe(true);
  });

  test("all used → order unchanged, all already_used true", () => {
    const out = rankIdeaPosts(posts, new Set(["a", "b", "c", "d"]));
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.every((p) => p.already_used === true)).toBe(true);
  });

  test("does not mutate the input array", () => {
    const input = [...posts];
    rankIdeaPosts(input, new Set(["a"]));
    expect(input.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});
