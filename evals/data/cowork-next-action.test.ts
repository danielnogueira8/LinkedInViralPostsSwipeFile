import { describe, expect, test } from "vitest";
import { getCoworkNextAction } from "@/app/(app)/dashboard/page";

const BASE = {
  hasTrackedCreators: true,
  voiceReady: true,
  freshInspirationCount: 10,
  pendingReviewCount: 0,
  readyUnscheduledCount: 0,
};

const BREAKOUT = {
  postId: "post-1",
  authorName: "Creator One",
  score: 12.4,
  postedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
};

describe("getCoworkNextAction", () => {
  test("setup gates outrank the breakout radar", () => {
    expect(
      getCoworkNextAction({ ...BASE, hasTrackedCreators: false, breakout: BREAKOUT }).kind,
    ).toBe("track_creators");
    expect(
      getCoworkNextAction({ ...BASE, voiceReady: false, breakout: BREAKOUT }).kind,
    ).toBe("voice");
    expect(
      getCoworkNextAction({ ...BASE, freshInspirationCount: 0, breakout: BREAKOUT }).kind,
    ).toBe("inspiration");
  });

  test("a fresh breakout outranks review + schedule nudges and carries the post id", () => {
    const action = getCoworkNextAction({
      ...BASE,
      pendingReviewCount: 4,
      readyUnscheduledCount: 2,
      breakout: BREAKOUT,
    });
    expect(action.kind).toBe("breakout");
    expect(action.breakoutPostId).toBe("post-1");
    expect(action.title).toContain("Creator One");
    expect(action.title).toContain("12×");
    expect(action.title).toContain("3h ago");
  });

  test("without a breakout, review + schedule keep their order", () => {
    expect(
      getCoworkNextAction({ ...BASE, pendingReviewCount: 2, readyUnscheduledCount: 1 }).kind,
    ).toBe("review");
    expect(
      getCoworkNextAction({ ...BASE, readyUnscheduledCount: 1 }).kind,
    ).toBe("schedule");
    expect(getCoworkNextAction(BASE).kind).toBe("batch");
  });
});
