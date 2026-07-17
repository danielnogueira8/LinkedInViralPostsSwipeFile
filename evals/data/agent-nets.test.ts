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
  rationaleTooGeneric,
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

describe("rationaleTooGeneric — the 'why I wrote it this way' quality gate", () => {
  // KEEPS a specific, concrete craft rationale — the whole point of the feature.
  test("keeps a specific first-person craft rationale", () => {
    expect(
      rationaleTooGeneric(
        "Opened on the failure instead of the win — vulnerability out-earns flexes in founder-LinkedIn.",
      ),
    ).toBeNull();
    expect(
      rationaleTooGeneric(
        "Cut the stats and led with the client's exact words to keep it human.",
      ),
    ).toBeNull();
    expect(
      rationaleTooGeneric(
        "Kept the list to three items so it stays skimmable on a phone.",
      ),
    ).toBeNull();
  });

  // DROPS empty praise — the exact AI-slop we don't want relocated into a caption.
  test("drops empty-praise rationales that name no concrete move", () => {
    expect(rationaleTooGeneric("I used an engaging hook.")).toBe("empty-praise");
    expect(rationaleTooGeneric("Crafted a compelling opener for you.")).toBe(
      "empty-praise",
    );
    expect(
      rationaleTooGeneric(
        "Wrote a punchy opening to hook your audience and drive engagement.",
      ),
    ).toBe("empty-praise");
    expect(
      rationaleTooGeneric("Structured it to maximize engagement and reach."),
    ).toBe("empty-praise");
    expect(rationaleTooGeneric("Kept it conversational.")).toBe("empty-praise");
  });

  test("drops chatbot-artifact and AI-vocabulary rationales", () => {
    expect(rationaleTooGeneric("Great question! I hope this helps.")).toBe(
      "chatbot-artifact",
    );
    expect(
      rationaleTooGeneric(
        "I delve into the topic at its core to underscore the importance.",
      ),
    ).toBe("ai-vocabulary");
  });

  test("drops a too-short or too-long rationale", () => {
    expect(rationaleTooGeneric("nice")).toBe("too-short");
    expect(rationaleTooGeneric("a".repeat(300))).toBe("too-long");
  });

  // Precision guard: a borderline-but-real reason that happens to contain a
  // praise adjective in a CONCRETE claim must NOT be eaten.
  test("does not fire on a concrete reason that mentions the audience specifically", () => {
    expect(
      rationaleTooGeneric(
        "Named the exact objection your buyers raise on sales calls so it reads like you're in the room.",
      ),
    ).toBeNull();
  });
});
