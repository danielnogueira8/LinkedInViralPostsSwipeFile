import { describe, test, expect } from "vitest";
import {
  byId,
  removeById,
  reinsertById,
  patchById,
  restoreFieldById,
} from "@/lib/optimistic";

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

  test("does not clobber concurrent list changes while rolling back", () => {
    const removed = byId([it("a"), it("b"), it("c")], "b");
    // During the await, one item was edited, one was removed elsewhere, and a
    // new item arrived. Rollback should only put b back into current state.
    const out = reinsertById([it("a", 10), it("new", 1)], removed);
    expect(out).toEqual([it("a", 10), it("b"), it("new", 1)]);
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

type Card = { id: string; status: string; v?: number };
const card = (id: string, status: string, v = 0): Card => ({ id, status, v });

describe("patchById — optimistic field change", () => {
  test("merges the patch onto the matching item only", () => {
    const list = [card("a", "idea"), card("b", "idea")];
    const out = patchById(list, "b", { status: "ready" });
    expect(out).toEqual([card("a", "idea"), card("b", "ready")]);
    expect(out).not.toBe(list); // new array
  });

  test("no-ops cleanly for an absent id", () => {
    const list = [card("a", "idea")];
    expect(patchById(list, "z", { status: "ready" })).toEqual(list);
  });
});

describe("restoreFieldById — reconciling field rollback", () => {
  test("reverts only the one field on the target card", () => {
    // Optimistic move set b → ready; on failure revert b.status to its prior.
    const current = [card("a", "idea"), card("b", "ready")];
    const out = restoreFieldById(current, "b", "status", "idea");
    expect(out).toEqual([card("a", "idea"), card("b", "idea")]);
  });

  test("does NOT resurrect a card deleted during the await (the bug it prevents)", () => {
    // While the b→ready PATCH was in flight, the user deleted b. On failure the
    // rollback must not bring b back.
    const current = [card("a", "idea")];
    const out = restoreFieldById(current, "b", "status", "idea");
    expect(out).toBe(current); // unchanged, same ref
  });

  test("does NOT clobber a concurrent change to a DIFFERENT card", () => {
    // While b→ready was in flight, card a was moved to done. Rolling back b's
    // status must leave a's new status intact.
    const current = [card("a", "done"), card("b", "ready")];
    const out = restoreFieldById(current, "b", "status", "idea");
    expect(out).toEqual([card("a", "done"), card("b", "idea")]);
  });

  test("does NOT clobber a concurrent change to ANOTHER field of the same card", () => {
    // While b's status change was in flight, b's `v` was bumped elsewhere.
    // Reverting status must preserve the new v.
    const current = [card("b", "ready", 42)];
    const out = restoreFieldById(current, "b", "status", "idea");
    expect(out).toEqual([card("b", "idea", 42)]);
  });

  test("handles a nullable field (planToPostOn cleared then rolled back)", () => {
    type Dated = { id: string; date: string | null };
    const current: Dated[] = [{ id: "a", date: "2026-08-01" }];
    const out = restoreFieldById(current, "a", "date", null);
    expect(out).toEqual([{ id: "a", date: null }]);
  });

  test("does not mutate the current array", () => {
    const current = [card("b", "ready")];
    const snap = JSON.parse(JSON.stringify(current));
    restoreFieldById(current, "b", "status", "idea");
    expect(current).toEqual(snap);
  });
});
