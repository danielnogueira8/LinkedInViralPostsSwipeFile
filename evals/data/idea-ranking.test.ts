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

  // recently_surfaced: a same-session "shown as an idea before" rotation aid,
  // distinct from already_used (already DRAFTED from). Ranks behind un-surfaced
  // posts within the not-yet-used group, so two independent "give me ideas"
  // calls over the same pool don't hand back the identical top posts both
  // times (the confirmed cause of ~80% idea overlap across repeat calls —
  // evals/live/prompt-quality-audit.live.test.ts test D).
  test("recently_surfaced posts rank behind un-surfaced ones, within the not-used group", () => {
    const surfaced = new Set(["a"]); // a was shown as an idea last call
    const out = rankIdeaPosts(posts, new Set(), surfaced);
    expect(out.map((p) => p.id)).toEqual(["b", "c", "d", "a"]);
  });

  test("already_used still dominates recently_surfaced (drafted posts rank last regardless)", () => {
    const used = new Set(["b"]);
    const surfaced = new Set(["a"]); // a merely surfaced, b actually drafted
    const out = rankIdeaPosts(posts, used, surfaced);
    expect(out.map((p) => p.id)).toEqual(["c", "d", "a", "b"]);
  });

  test("annotates each post with recently_surfaced", () => {
    const out = rankIdeaPosts(posts, new Set(), new Set(["a", "d"]));
    const byId = Object.fromEntries(out.map((p) => [p.id, p.recently_surfaced]));
    expect(byId).toEqual({ a: true, b: false, c: false, d: true });
  });
});
