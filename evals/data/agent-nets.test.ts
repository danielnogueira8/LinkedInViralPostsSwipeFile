import { describe, expect, test } from "vitest";
// The nets now live in the shared specialists module. This asserts they're
// importable from there directly (what run.ts and batch/weekly.ts both do) and
// still behave identically after the move.
import {
  looksCorruptedDraft,
  normalizeDraftKey,
  stripEmDashes,
  aiTellMetrics,
} from "@/lib/agent/specialists/nets";

describe("shared nets module", () => {
  test("stripEmDashes turns a clause-break em dash into a comma", () => {
    expect(stripEmDashes("I shipped it — finally.")).toBe("I shipped it, finally.");
  });

  test("stripEmDashes leaves en-dash number ranges alone", () => {
    expect(stripEmDashes("post 3–5 times a week")).toBe("post 3–5 times a week");
  });

  test("looksCorruptedDraft flags a leaked fence marker, passes clean prose", () => {
    expect(looksCorruptedDraft("```post\nhi")).toBe("leaked code-fence marker");
    expect(looksCorruptedDraft("A perfectly clean post body.")).toBeNull();
  });

  test("normalizeDraftKey collapses whitespace + casing for dedupe", () => {
    expect(normalizeDraftKey("Hello   World\n\n")).toBe(normalizeDraftKey("hello world"));
  });

  test("aiTellMetrics catches a rule-of-three cadence", () => {
    expect(aiTellMetrics("Fast, cheap, easy.")).toContain("rule-of-three");
    expect(aiTellMetrics("This is a normal sentence with no tells.")).toEqual([]);
  });

});
