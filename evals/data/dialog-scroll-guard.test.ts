import { describe, expect, it } from "vitest";
import {
  dialogScrollDirection,
  shouldPreventDialogKeyScroll,
  shouldPreventDialogTouchMove,
} from "@/lib/dialog-scroll-guard";

describe("dialog scroll guard", () => {
  it("blocks page-scroll keys when the dialog cannot consume them", () => {
    expect(
      shouldPreventDialogKeyScroll({
        canScrollInsideDialog: false,
        key: "PageDown",
        target: "other",
      }),
    ).toBe(true);
    expect(
      shouldPreventDialogKeyScroll({
        canScrollInsideDialog: true,
        key: "PageDown",
        target: "other",
      }),
    ).toBe(false);
    expect(
      shouldPreventDialogKeyScroll({
        canScrollInsideDialog: false,
        key: "ArrowRight",
        target: "other",
      }),
    ).toBe(false);
  });

  it("preserves editing, activation, and media controls", () => {
    expect(
      shouldPreventDialogKeyScroll({
        canScrollInsideDialog: false,
        key: "PageDown",
        target: "text-input",
      }),
    ).toBe(true);
    expect(
      shouldPreventDialogKeyScroll({
        canScrollInsideDialog: false,
        key: "Home",
        target: "text-input",
      }),
    ).toBe(false);
    expect(
      shouldPreventDialogKeyScroll({
        canScrollInsideDialog: false,
        key: " ",
        target: "activation",
      }),
    ).toBe(false);
    expect(
      shouldPreventDialogKeyScroll({
        canScrollInsideDialog: false,
        key: "ArrowDown",
        target: "media",
      }),
    ).toBe(false);
  });

  it("maps page keys to the direction the dialog must be able to scroll", () => {
    expect(dialogScrollDirection("PageDown")).toBe(1);
    expect(dialogScrollDirection("PageUp")).toBe(-1);
    expect(dialogScrollDirection(" ", true)).toBe(-1);
  });

  it("contains single-touch panning while preserving zoom and media scrubbing", () => {
    expect(
      shouldPreventDialogTouchMove({
        canScrollInsideDialog: false,
        deltaX: 0,
        deltaY: 100,
        target: "other",
        touchCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldPreventDialogTouchMove({
        canScrollInsideDialog: true,
        deltaX: 0,
        deltaY: 100,
        target: "other",
        touchCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldPreventDialogTouchMove({
        canScrollInsideDialog: false,
        deltaX: 100,
        deltaY: 5,
        target: "media",
        touchCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldPreventDialogTouchMove({
        canScrollInsideDialog: false,
        deltaX: 0,
        deltaY: 100,
        target: "other",
        touchCount: 2,
      }),
    ).toBe(false);
  });
});
