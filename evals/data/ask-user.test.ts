import { describe, test, expect } from "vitest";
import { buildAskQuestion } from "@/lib/agent/run";
import { composeAskAnswer } from "@/app/(app)/dashboard/chat-workspace";

// ---------------------------------------------------------------------------
// ask_user — the clarifying-question feature. buildAskQuestion validates the
// agent's tool args into an AskQuestion (or an error the loop feeds back without
// ending the turn). composeAskAnswer builds the answer message the card sends.
// ---------------------------------------------------------------------------

describe("buildAskQuestion — agent-side arg validation", () => {
  test("a well-formed ask passes and normalizes", () => {
    const r = buildAskQuestion({
      question: "  Did you mean idea #5, or all 5?  ",
      options: ["Just idea #5", "All 5 ideas"],
    });
    expect("ask" in r).toBe(true);
    if ("ask" in r) {
      expect(r.ask.question).toBe("Did you mean idea #5, or all 5?");
      expect(r.ask.options).toEqual(["Just idea #5", "All 5 ideas"]);
      expect(r.ask.allowOther).toBe(true); // defaults on
    }
  });

  test("allowOther: false is respected", () => {
    const r = buildAskQuestion({
      question: "Pick one",
      options: ["A", "B"],
      allowOther: false,
    });
    expect("ask" in r && r.ask.allowOther).toBe(false);
  });

  test("trims, drops blank options, caps at 6, truncates long labels", () => {
    const r = buildAskQuestion({
      question: "Q",
      options: ["a", "", "  ", "b", "c", "d", "e", "f", "g", "x".repeat(200)],
    });
    expect("ask" in r).toBe(true);
    if ("ask" in r) {
      expect(r.ask.options.length).toBe(6);
      for (const o of r.ask.options) expect(o.length).toBeLessThanOrEqual(80);
    }
  });

  test("missing/empty question → error (loop won't end the turn)", () => {
    expect(buildAskQuestion({ options: ["a", "b"] })).toHaveProperty("error");
    expect(buildAskQuestion({ question: "   ", options: ["a", "b"] })).toHaveProperty("error");
  });

  test("fewer than 2 usable options → error", () => {
    expect(buildAskQuestion({ question: "Q", options: ["only one"] })).toHaveProperty("error");
    expect(buildAskQuestion({ question: "Q", options: [] })).toHaveProperty("error");
    expect(buildAskQuestion({ question: "Q" })).toHaveProperty("error");
  });

  test("malformed JSON args (null) → error, not a throw", () => {
    expect(buildAskQuestion(null)).toHaveProperty("error");
  });
});

describe("composeAskAnswer — building the answer message", () => {
  test("single selection", () => {
    expect(composeAskAnswer(["Just idea #5"], "")).toBe("Just idea #5");
  });

  test("multiple selections are joined", () => {
    expect(composeAskAnswer(["Idea #5", "Idea #2"], "")).toBe("Idea #5; Idea #2");
  });

  test("free text only", () => {
    expect(composeAskAnswer([], "actually, ideas 2 and 4")).toBe(
      "actually, ideas 2 and 4",
    );
  });

  test("selections + free text combine", () => {
    expect(composeAskAnswer(["Idea #5"], "and make it punchier")).toBe(
      "Idea #5; and make it punchier",
    );
  });

  test("nothing chosen → empty (submit is disabled in that case)", () => {
    expect(composeAskAnswer([], "")).toBe("");
    expect(composeAskAnswer([], "   ")).toBe("");
  });
});
