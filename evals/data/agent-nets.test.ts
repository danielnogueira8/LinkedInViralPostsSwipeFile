import { describe, expect, test } from "vitest";
// The nets now live in the shared specialists module. This asserts they're
// importable from there directly (what run.ts and batch/weekly.ts both do) and
// still behave identically after the move.
import {
  areDraftsNearDuplicate,
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

  test("near-duplicate guard catches formatting and one-word disguises", () => {
    const original =
      "A public body of work keeps explaining how you think after your title changes and gives future clients evidence they can inspect before a call.";
    expect(
      areDraftsNearDuplicate(
        original,
        original.replace("clients", "buyers").replaceAll(" ", "  \n"),
      ),
    ).toBe(true);
  });

  test("near-duplicate guard allows genuinely distinct same-topic posts", () => {
    expect(
      areDraftsNearDuplicate(
        "A public body of work keeps explaining how you think after your title changes and gives future clients evidence they can inspect before a call.",
        "Recruiters cannot evaluate invisible judgment. Publish one useful lesson each week so opportunity arrives with context instead of beginning from a blank resume.",
      ),
    ).toBe(false);
  });

  test("short snippets require exact equality instead of fuzzy rejection", () => {
    expect(areDraftsNearDuplicate("Build proof now", "Build proof now")).toBe(
      true,
    );
    expect(
      areDraftsNearDuplicate("Build proof now", "Publish proof now"),
    ).toBe(false);
  });

  test("aiTellMetrics catches a rule-of-three cadence", () => {
    expect(aiTellMetrics("Fast, cheap, easy.")).toContain("rule-of-three");
    expect(aiTellMetrics("This is a normal sentence with no tells.")).toEqual([]);
  });

});
