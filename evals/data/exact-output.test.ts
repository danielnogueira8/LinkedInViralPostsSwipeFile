import { describe, expect, test } from "vitest";
import { requestedExactFinalLine } from "@/lib/agent/exact-output";

describe("requestedExactFinalLine", () => {
  test.each([
    "Make only the hook punchier. Preserve the rest of the post and keep the exact final line unchanged.",
    "Tighten the opening and leave the exact final line intact.",
    "Rewrite the hook but retain the exact last line as is.",
    "Improve the first line and maintain the exact closing line the same.",
  ])("does not mistake a preservation qualifier for the literal final line: %s", (instruction) => {
    expect(requestedExactFinalLine(instruction)).toBeNull();
  });

  test("still extracts an explicitly supplied exact final line", () => {
    expect(
      requestedExactFinalLine(
        "Make the hook punchier and keep the exact final line #SWIPEIN_QA_20260716.",
      ),
    ).toBe("#SWIPEIN_QA_20260716.");
  });

  test("allows a quoted value even when its text is a preservation word", () => {
    expect(
      requestedExactFinalLine('End with this exact final line: "unchanged."'),
    ).toBe("unchanged.");
  });
});
