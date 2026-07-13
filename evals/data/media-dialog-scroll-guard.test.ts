import { describe, expect, it } from "vitest";
import {
  shouldPreventMediaKeyScroll,
  shouldPreventMediaTouchMove,
  shouldPreventMediaWheel,
} from "@/lib/media-dialog-scroll-guard";

describe("media dialog scroll guard", () => {
  it("blocks page-scroll gestures but preserves browser zoom", () => {
    expect(shouldPreventMediaWheel(false)).toBe(true);
    expect(shouldPreventMediaWheel(true)).toBe(false);
    expect(
      shouldPreventMediaTouchMove({
        touchCount: 2,
        target: "other",
        deltaX: 0,
        deltaY: 120,
      }),
    ).toBe(false);
  });

  it("allows horizontal video scrubbing but blocks vertical video panning", () => {
    expect(
      shouldPreventMediaTouchMove({
        touchCount: 1,
        target: "video",
        deltaX: 120,
        deltaY: 8,
      }),
    ).toBe(false);
    expect(
      shouldPreventMediaTouchMove({
        touchCount: 1,
        target: "video",
        deltaX: 8,
        deltaY: 120,
      }),
    ).toBe(true);
  });

  it("blocks page keys while preserving activation and media controls", () => {
    expect(shouldPreventMediaKeyScroll("ArrowDown", "activation")).toBe(true);
    expect(shouldPreventMediaKeyScroll(" ", "activation")).toBe(false);
    expect(shouldPreventMediaKeyScroll("ArrowDown", "video")).toBe(false);
    expect(shouldPreventMediaKeyScroll("PageDown", "video")).toBe(true);
    expect(shouldPreventMediaKeyScroll("ArrowRight", "other")).toBe(false);
  });
});
