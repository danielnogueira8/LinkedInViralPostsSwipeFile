import { describe, expect, test } from "vitest";
import {
  emptyHistory,
  pushHistory,
  undo,
  redo,
  snapshot,
  type EditHistory,
} from "@/lib/edit-history";

// ---------------------------------------------------------------------------
// Undo/redo for the controlled draft textarea. The interesting behaviour is the
// coalescing rule — typing collapses into one step, but a formatting transform
// or an AI rewrite always gets its own — so that's what's pinned here.
// ---------------------------------------------------------------------------

// Apply a sequence of edits, returning the final history + value.
function type(
  h: EditHistory,
  edits: Array<[prev: string, next: string, at: number]>,
): EditHistory {
  return edits.reduce((acc, [prev, next, at]) => pushHistory(acc, prev, next, at), h);
}

describe("pushHistory coalescing", () => {
  test("fast consecutive keystrokes collapse into ONE undo step", () => {
    // Six single-character edits, 50ms apart: one step, not six.
    const h = type(emptyHistory(), [
      ["", "s", 0],
      ["s", "sh", 50],
      ["sh", "shi", 100],
      ["shi", "ship", 150],
      ["ship", "ship ", 200],
      ["ship ", "ship i", 250],
    ]);
    expect(h.past).toHaveLength(1);
    expect(h.past[0]).toBe(""); // undo returns to the original state
  });

  test("a pause starts a new undo step", () => {
    const h = type(emptyHistory(), [
      ["", "a", 0],
      ["a", "ab", 100],
      ["ab", "abc", 5000], // well past the coalesce window
    ]);
    expect(h.past).toHaveLength(2);
  });

  test("a LARGE change always gets its own step, even mid-burst", () => {
    // This is the formatting/AI-rewrite case: it must stay individually
    // undoable even if it lands milliseconds after a keystroke.
    const h = type(emptyHistory(), [
      ["", "a", 0],
      ["a", "a really long AI rewritten paragraph", 50],
    ]);
    expect(h.past).toHaveLength(2);
  });

  test("a no-op edit records nothing", () => {
    const h = pushHistory(emptyHistory(), "same", "same", 0);
    expect(h.past).toHaveLength(0);
  });
});

describe("snapshot (streaming edits, e.g. the AI rewrite)", () => {
  test("records one undo point regardless of how many updates follow", () => {
    // The rewrite streams many intermediate values; only the pre-rewrite text
    // should be undoable, so one undo returns the original.
    let h = snapshot(emptyHistory(), "the original sentence", 0);
    // stream lands as raw updates that never touch history
    const undone = undo(h, "a totally rewritten sentence")!;
    expect(undone.value).toBe("the original sentence");
    h = undone.history;
    expect(undo(h, "the original sentence")).toBeNull();
  });

  test("ignores coalescing (always pushes, unlike a keystroke)", () => {
    let h = pushHistory(emptyHistory(), "", "a", 0);
    h = snapshot(h, "a", 10); // 10ms later — a keystroke would coalesce
    expect(h.past).toHaveLength(2);
  });

  test("does not stack duplicate snapshots of identical text", () => {
    let h = snapshot(emptyHistory(), "same", 0);
    h = snapshot(h, "same", 50);
    expect(h.past).toHaveLength(1);
  });

  test("discards the redo branch, like any new edit", () => {
    const h = pushHistory(emptyHistory(), "v1", "v2", 0);
    const undone = undo(h, "v2")!;
    expect(undone.history.future).toHaveLength(1);
    expect(snapshot(undone.history, "v1", 100).future).toHaveLength(0);
  });
});

describe("undo / redo", () => {
  test("undo restores the previous value and redo returns to it", () => {
    const h = pushHistory(emptyHistory(), "before", "after", 0);

    const undone = undo(h, "after");
    expect(undone).not.toBeNull();
    expect(undone!.value).toBe("before");

    const redone = redo(undone!.history, "before");
    expect(redone).not.toBeNull();
    expect(redone!.value).toBe("after");
  });

  test("undo/redo on an empty stack is null, not a crash", () => {
    expect(undo(emptyHistory(), "x")).toBeNull();
    expect(redo(emptyHistory(), "x")).toBeNull();
  });

  test("a NEW edit after undo discards the redo branch", () => {
    // Standard editor semantics: you can't redo into a future you diverged from.
    const h = pushHistory(emptyHistory(), "v1", "v2", 0);
    const undone = undo(h, "v2")!;
    expect(undone.history.future).toHaveLength(1);

    const diverged = pushHistory(undone.history, "v1", "v3", 10_000);
    expect(diverged.future).toHaveLength(0);
    expect(redo(diverged, "v3")).toBeNull();
  });

  test("multi-step undo walks all the way back in order", () => {
    let h = pushHistory(emptyHistory(), "one", "two", 0);
    h = pushHistory(h, "two", "three", 10_000);

    const first = undo(h, "three")!;
    expect(first.value).toBe("two");
    const second = undo(first.history, first.value)!;
    expect(second.value).toBe("one");
    expect(undo(second.history, second.value)).toBeNull();
  });

  test("the stack stays bounded under a long session", () => {
    let h = emptyHistory();
    for (let i = 0; i < 500; i += 1) {
      h = pushHistory(h, `v${i}`, `v${i + 1}`, i * 10_000);
    }
    expect(h.past.length).toBeLessThanOrEqual(100);
    // and it kept the MOST RECENT states, not the oldest
    expect(h.past[h.past.length - 1]).toBe("v499");
  });
});
