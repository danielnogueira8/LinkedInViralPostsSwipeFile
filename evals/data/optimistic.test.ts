import { describe, test, expect } from "vitest";
import { byId, removeById, reinsertById } from "@/lib/optimistic";

// ---------------------------------------------------------------------------
// The "reconcile, don't restore" optimistic-list guardrail. The load-bearing
// property: a rollback re-inserts ONLY the removed item into CURRENT state, so
// anything that changed during the await (a streamed-in item, a concurrent
// action) is NOT clobbered — the bug that shipped twice (PR #408).
// ---------------------------------------------------------------------------

type Item = { id: string; v: number };
const it = (id: string, v = 0): Item => ({ id, v });

describe("byId", () => {
  test("captures the item + its index", () => {
    expect(byId([it("a"), it("b"), it("c")], "b")).toEqual({ item: it("b"), index: 1 });
  });
  test("null when the id isn't present", () => {
    expect(byId([it("a")], "z")).toBeNull();
  });
});

describe("removeById", () => {
  test("returns a new list without the id", () => {
    const list = [it("a"), it("b")];
    const out = removeById(list, "a");
    expect(out.map((x) => x.id)).toEqual(["b"]);
    expect(out).not.toBe(list); // new array
  });
  test("no-ops cleanly for an absent id", () => {
    expect(removeById([it("a")], "z").map((x) => x.id)).toEqual(["a"]);
  });
});

describe("reinsertById — reconciling rollback", () => {
  test("re-inserts the removed item at its original index", () => {
    const removed = byId([it("a"), it("b"), it("c")], "b");
    // current = the list after the optimistic remove
    const out = reinsertById([it("a"), it("c")], removed);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  test("KEEPS an item that appeared during the await (the bug it prevents)", () => {
    const removed = byId([it("old")], "old");
    // During the await, 'new' was added → current is ['new'].
    const out = reinsertById([it("new")], removed);
    expect(out.map((x) => x.id).sort()).toEqual(["new", "old"]);
  });

  test("null removed → current unchanged (same ref)", () => {
    const cur = [it("a")];
    expect(reinsertById(cur, null)).toBe(cur);
  });

  test("no duplicate if the item is somehow already back", () => {
    const cur = [it("a"), it("b")];
    const out = reinsertById(cur, { item: it("b"), index: 0 });
    expect(out).toBe(cur); // nothing to do
    expect(out.filter((x) => x.id === "b")).toHaveLength(1);
  });

  test("clamps an out-of-range original index", () => {
    const out = reinsertById([it("only")], { item: it("back"), index: 99 });
    expect(out.map((x) => x.id)).toEqual(["only", "back"]);
  });

  test("does not mutate the current array", () => {
    const cur = [it("a")];
    const snap = JSON.parse(JSON.stringify(cur));
    reinsertById(cur, { item: it("b"), index: 0 });
    expect(cur).toEqual(snap);
  });

  test("end-to-end: remove then reconcile-rollback restores the original order", () => {
    const list = [it("a"), it("b"), it("c")];
    const removed = byId(list, "b");
    const afterRemove = removeById(list, "b");
    const rolledBack = reinsertById(afterRemove, removed);
    expect(rolledBack.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
