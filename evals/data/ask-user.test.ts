import { describe, test, expect } from "vitest";
import { buildAskQuestion, type AskQuestion } from "@/lib/agent/run";
import {
  composeAskAnswer,
  resolveAskSubmission,
  attachAskToLastAssistant,
  type Message,
} from "@/app/(app)/dashboard/chat-workspace";

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

describe("attachAskToLastAssistant — re-graft the live-only question after reload", () => {
  const ask = { question: "Idea #5 or all 5?", options: ["#5", "All 5"], allowOther: true };
  const m = (id: string, role: "user" | "assistant"): Message => ({ id, role, text: id });

  test("attaches the ask to the LAST assistant message", () => {
    const out = attachAskToLastAssistant([m("u1", "user"), m("a1", "assistant")], ask);
    expect(out[1].ask).toEqual(ask);
    expect(out[0].ask).toBeUndefined();
  });

  test("attaches to the last assistant even when a later user msg exists is N/A — picks the final assistant", () => {
    // A transcript ending with the assistant question (the real shape).
    const out = attachAskToLastAssistant(
      [m("u1", "user"), m("a1", "assistant"), m("u2", "user"), m("a2", "assistant")],
      ask,
    );
    expect(out[3].ask).toEqual(ask); // the LATEST assistant
    expect(out[1].ask).toBeUndefined();
  });

  test("no pending ask → returns the messages unchanged (same reference)", () => {
    const msgs = [m("u1", "user"), m("a1", "assistant")];
    expect(attachAskToLastAssistant(msgs, undefined)).toBe(msgs);
  });

  test("no assistant message → unchanged", () => {
    const msgs = [m("u1", "user")];
    const out = attachAskToLastAssistant(msgs, ask);
    expect(out.every((x) => x.ask === undefined)).toBe(true);
  });

  test("does not mutate the input array", () => {
    const msgs = [m("a1", "assistant")];
    attachAskToLastAssistant(msgs, ask);
    expect(msgs[0].ask).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// doneOption (Bug #2): a terminal "I'm satisfied — done" option lets the client
// close the card with NO model turn. buildAskQuestion validates the agent's
// declared doneOption against the real options; resolveAskSubmission decides
// whether a submission closes (done) or sends a message.
// ---------------------------------------------------------------------------

describe("buildAskQuestion — doneOption validation", () => {
  test("a doneOption matching one of the options is kept", () => {
    const r = buildAskQuestion({
      question: "How's the draft?",
      options: ["Tighten the hook", "They're good — done"],
      doneOption: "They're good — done",
    });
    expect("ask" in r && r.ask.doneOption).toBe("They're good — done");
  });

  test("a doneOption that matches NO option is dropped (not invented)", () => {
    const r = buildAskQuestion({
      question: "How's the draft?",
      options: ["Tighten the hook", "Make it shorter"],
      doneOption: "All set",
    });
    expect("ask" in r && "doneOption" in r.ask).toBe(false);
  });

  test("doneOption is matched after the same trim/truncate as options", () => {
    // The option gets trimmed; a doneOption with surrounding space still matches.
    const r = buildAskQuestion({
      question: "How's the draft?",
      options: ["  They're good — done  ", "Tighten"],
      doneOption: "They're good — done",
    });
    expect("ask" in r && r.ask.doneOption).toBe("They're good — done");
  });

  test("omitting doneOption leaves it absent", () => {
    const r = buildAskQuestion({ question: "Q", options: ["A", "B"] });
    expect("ask" in r && "doneOption" in r.ask).toBe(false);
  });
});

describe("resolveAskSubmission — done short-circuit vs send", () => {
  const ask: AskQuestion = {
    question: "How's the draft?",
    options: ["Tighten the hook", "Make it shorter", "They're good — done"],
    allowOther: true,
    doneOption: "They're good — done",
  };

  test("picking ONLY the done option → done (no send)", () => {
    expect(resolveAskSubmission(ask, ["They're good — done"], "")).toEqual({
      kind: "done",
    });
  });

  test("picking a real action option → send", () => {
    expect(resolveAskSubmission(ask, ["Tighten the hook"], "")).toEqual({
      kind: "send",
      text: "Tighten the hook",
    });
  });

  test("done + another option → send (it's a real instruction)", () => {
    const r = resolveAskSubmission(
      ask,
      ["They're good — done", "Make it shorter"],
      "",
    );
    expect(r.kind).toBe("send");
  });

  test("done option + typed free text → send (the text matters)", () => {
    const r = resolveAskSubmission(ask, ["They're good — done"], "but shorten #2");
    expect(r).toEqual({
      kind: "send",
      text: "They're good — done; but shorten #2",
    });
  });

  test("an ask with NO doneOption never short-circuits", () => {
    const noDone: AskQuestion = {
      question: "Idea #5, or all 5?",
      options: ["Just #5", "All 5"],
      allowOther: true,
    };
    expect(resolveAskSubmission(noDone, ["Just #5"], "")).toEqual({
      kind: "send",
      text: "Just #5",
    });
  });
});
