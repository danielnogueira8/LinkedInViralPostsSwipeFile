import { describe, expect, test } from "vitest";
import { resolveTurnCount } from "@/lib/agent/turn/compile";

describe("resolveTurnCount — the ONE turn count rule (1-6, UI > message > default)", () => {
  test("defaults to 1 when neither source provides a count", () => {
    expect(resolveTurnCount({})).toEqual({ count: 1, source: "default" });
    expect(resolveTurnCount({ uiDraftCount: null, messageCount: null })).toEqual({
      count: 1,
      source: "default",
    });
  });

  test("the UI override wins over the message count", () => {
    expect(
      resolveTurnCount({ uiDraftCount: 4, messageCount: 2 }),
    ).toEqual({ count: 4, source: "ui" });
  });

  test("the message count applies when the UI did not select one", () => {
    expect(resolveTurnCount({ messageCount: 3 })).toEqual({
      count: 3,
      source: "message",
    });
    expect(resolveTurnCount({ uiDraftCount: null, messageCount: 6 })).toEqual({
      count: 6,
      source: "message",
    });
  });

  test("accepts the full 1-6 range from either source", () => {
    for (const count of [1, 2, 3, 4, 5, 6] as const) {
      expect(resolveTurnCount({ uiDraftCount: count })).toEqual({
        count,
        source: "ui",
      });
      expect(resolveTurnCount({ messageCount: count })).toEqual({
        count,
        source: "message",
      });
    }
  });

  test("clamps valid integers into the range instead of dropping them", () => {
    expect(resolveTurnCount({ messageCount: 10 })).toEqual({
      count: 6,
      source: "message",
    });
    expect(resolveTurnCount({ uiDraftCount: 99 })).toEqual({
      count: 6,
      source: "ui",
    });
    expect(resolveTurnCount({ messageCount: 0 })).toEqual({
      count: 1,
      source: "message",
    });
    expect(resolveTurnCount({ messageCount: -3 })).toEqual({
      count: 1,
      source: "message",
    });
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5, "3" as unknown as number])(
    "ignores junk input %s and falls to the next source",
    (junk) => {
      expect(resolveTurnCount({ uiDraftCount: junk, messageCount: 2 })).toEqual({
        count: 2,
        source: "message",
      });
      expect(resolveTurnCount({ uiDraftCount: junk })).toEqual({
        count: 1,
        source: "default",
      });
      expect(resolveTurnCount({ messageCount: junk })).toEqual({
        count: 1,
        source: "default",
      });
    },
  );
});
