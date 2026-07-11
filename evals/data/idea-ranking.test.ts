import { describe, test, expect } from "vitest";
import { rankIdeaPosts, rotateFreshBand } from "@/lib/agent/tools";

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

// rotateFreshBand: the durable-cursor rotation that fixes "always models the
// same post". It left-rotates ONLY the leading run of not-used, not-surfaced
// posts, and only when that band overfills the final selection — so repeated
// asks lead with a different fresh post while every ranking guarantee holds.
describe("rotateFreshBand — deterministic rotation of the fresh band", () => {
  const fresh = (id: string) => ({ id, already_used: false, recently_surfaced: false });
  const used = (id: string) => ({ id, already_used: true, recently_surfaced: false });
  const surfaced = (id: string) => ({ id, already_used: false, recently_surfaced: true });

  test("rotates the fresh band by the cursor; different cursors → different #1", () => {
    const ranked = [fresh("a"), fresh("b"), fresh("c"), fresh("d"), fresh("e")];
    // keep=2, band=5 → rotation active. Successive cursors advance the leader.
    expect(rotateFreshBand(ranked, 0, 2).map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(rotateFreshBand(ranked, 1, 2).map((p) => p.id)).toEqual(["b", "c", "d", "e", "a"]);
    expect(rotateFreshBand(ranked, 2, 2).map((p) => p.id)).toEqual(["c", "d", "e", "a", "b"]);
    // wraps around the band size
    expect(rotateFreshBand(ranked, 5, 2).map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("NEVER rotates a used/surfaced post into the lead — the band excludes them", () => {
    // Fresh band is just [a, b]; c (used) and d (surfaced) must stay pinned last.
    const ranked = [fresh("a"), fresh("b"), used("c"), surfaced("d")];
    // band=2, keep=1 → rotate the 2 fresh; the trailing sunk posts don't move.
    expect(rotateFreshBand(ranked, 1, 1).map((p) => p.id)).toEqual(["b", "a", "c", "d"]);
    // Any cursor: c and d remain the last two, never promoted.
    for (const cur of [0, 1, 2, 3, 7]) {
      const out = rotateFreshBand(ranked, cur, 1).map((p) => p.id);
      expect(out.slice(-2)).toEqual(["c", "d"]);
    }
  });

  test("no-op when the fresh band can't overfill the selection (small pools stay put)", () => {
    const ranked = [fresh("a"), fresh("b")];
    // band=2, keep=2 → band <= keep → no rotation regardless of cursor.
    expect(rotateFreshBand(ranked, 1, 2).map((p) => p.id)).toEqual(["a", "b"]);
    expect(rotateFreshBand(ranked, 3, 2).map((p) => p.id)).toEqual(["a", "b"]);
    // keep <= 0 is also a no-op.
    expect(rotateFreshBand(ranked, 1, 0).map((p) => p.id)).toEqual(["a", "b"]);
  });

  test("normalizes a negative or huge cursor via modulo", () => {
    const ranked = [fresh("a"), fresh("b"), fresh("c"), fresh("d")];
    expect(rotateFreshBand(ranked, -1, 1).map((p) => p.id)).toEqual(["d", "a", "b", "c"]);
    expect(rotateFreshBand(ranked, 4, 1).map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});
