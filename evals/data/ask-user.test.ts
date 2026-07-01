import { describe, test, expect } from "vitest";
import { buildAskQuestion, type AskQuestion } from "@/lib/agent/run";
import {
  composeAskAnswer,
  resolveAskSubmission,
  toggleAskOption,
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

  test("multiSelect defaults OFF (single-select) when omitted", () => {
    const r = buildAskQuestion({ question: "Which idea?", options: ["A", "B"] });
    // Omitted from the object entirely (falsy), so the card renders as radios.
    expect("ask" in r && r.ask.multiSelect).toBeUndefined();
  });

  test("multiSelect: true is carried through (the after-draft edit menu)", () => {
    const r = buildAskQuestion({
      question: "What next?",
      options: ["Shorter", "Add a CTA"],
      multiSelect: true,
    });
    expect("ask" in r && r.ask.multiSelect).toBe(true);
  });

  test("a non-boolean / truthy-but-not-true multiSelect is treated as OFF (strict)", () => {
    // Only literal `true` enables multi — a stray "yes"/1 shouldn't accidentally
    // open a single-answer question up to multiple picks.
    for (const bad of ["true", 1, {}, "yes"]) {
      const r = buildAskQuestion({
        question: "Q",
        options: ["A", "B"],
        multiSelect: bad as unknown,
      });
      expect("ask" in r && r.ask.multiSelect).toBeUndefined();
    }
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

  // THE bug: the agent tagged "Use your best judgment" (a proceed/decide-for-me
  // escape) as the doneOption on a pre-draft question ("which milestone?"), so
  // picking it marked the card DONE and sent NOTHING — no post was ever written.
  // A "you decide / proceed" escape must NEVER be terminal: it requires the model
  // to act. buildAskQuestion strips a mis-tagged doneOption of that family.
  test("a 'Use your best judgment' doneOption is STRIPPED (proceed ≠ done)", () => {
    const r = buildAskQuestion({
      question: "Which milestone should the post be built around?",
      options: ["First $10k month", "First hire", "Use your best judgment"],
      doneOption: "Use your best judgment",
    });
    // The option itself stays (it's a valid pick)...
    expect("ask" in r && r.ask.options).toContain("Use your best judgment");
    // ...but it is NOT the doneOption, so picking it will SEND (model proceeds).
    expect("ask" in r && "doneOption" in r.ask).toBe(false);
  });

  test("the proceed-escape family is all stripped as doneOption", () => {
    for (const escape of [
      "Use your best judgment",
      "Use your best judgement", // British spelling
      "You decide",
      "Whatever you think",
      "Your call",
      "Surprise me",
      "Up to you",
    ]) {
      const r = buildAskQuestion({
        question: "Which angle?",
        options: ["Contrarian", escape],
        doneOption: escape,
      });
      expect(
        "ask" in r && "doneOption" in r.ask,
        `expected "${escape}" to be rejected as a doneOption`,
      ).toBe(false);
    }
  });

  test("a genuine we're-done option is NOT mistaken for a proceed escape", () => {
    // Regression guard the other way: real done options must survive.
    for (const done of [
      "They're good — done",
      "Looks great",
      "Nothing to change",
      "It's good — done",
    ]) {
      const r = buildAskQuestion({
        question: "How's the draft?",
        options: ["Tighten the hook", done],
        doneOption: done,
      });
      expect(
        "ask" in r && r.ask.doneOption,
        `expected "${done}" to remain the doneOption`,
      ).toBe(done);
    }
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

// ---------------------------------------------------------------------------
// toggleAskOption — MULTI-SELECT (ask.multiSelect: true — the after-draft edit
// menu). Several action options compose ("Tighten the hook" + "Add a CTA"), but
// the terminal done/escape option is mutually exclusive with them (finding #24)
// so a user can't send a self-contradictory answer ("Add a CTA" + "It's good —
// done"). NOTE: multiSelect must be set explicitly here — the default (below)
// is single-select.
// ---------------------------------------------------------------------------

describe("toggleAskOption — multi-select with an exclusive done option", () => {
  const ask: AskQuestion = {
    question: "How's the draft?",
    options: ["Tighten the hook", "Make it shorter", "Add a CTA", "They're good — done"],
    allowOther: true,
    multiSelect: true,
    doneOption: "They're good — done",
  };

  test("two action options compose (multi-select)", () => {
    let sel: string[] = [];
    sel = toggleAskOption(ask, sel, "Tighten the hook");
    sel = toggleAskOption(ask, sel, "Add a CTA");
    expect(sel).toEqual(["Tighten the hook", "Add a CTA"]);
  });

  test("picking the done option clears all action picks", () => {
    let sel = ["Tighten the hook", "Add a CTA"];
    sel = toggleAskOption(ask, sel, "They're good — done");
    expect(sel).toEqual(["They're good — done"]);
  });

  test("picking an action option clears the done pick", () => {
    let sel = ["They're good — done"];
    sel = toggleAskOption(ask, sel, "Make it shorter");
    expect(sel).toEqual(["Make it shorter"]);
  });

  test("toggling an already-selected option just removes it", () => {
    let sel = ["Tighten the hook", "Make it shorter"];
    sel = toggleAskOption(ask, sel, "Tighten the hook");
    expect(sel).toEqual(["Make it shorter"]);
  });

  test("deselecting the done option leaves an empty selection", () => {
    expect(toggleAskOption(ask, ["They're good — done"], "They're good — done")).toEqual([]);
  });

  test("multi-select with no doneOption freely composes", () => {
    const noDone: AskQuestion = {
      question: "Which angles?",
      options: ["A", "B", "C"],
      allowOther: true,
      multiSelect: true,
    };
    let sel: string[] = [];
    sel = toggleAskOption(noDone, sel, "A");
    sel = toggleAskOption(noDone, sel, "C");
    expect(sel).toEqual(["A", "C"]);
  });

  test("the resulting selection never contradicts itself (done + action)", () => {
    // Property: after any toggle, the done option and an action option are never
    // both present.
    let sel: string[] = [];
    for (const opt of ["Tighten the hook", "They're good — done", "Add a CTA", "They're good — done"]) {
      sel = toggleAskOption(ask, sel, opt);
      const hasDone = sel.includes(ask.doneOption!);
      const hasAction = sel.some((o) => o !== ask.doneOption);
      expect(hasDone && hasAction).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// toggleAskOption — SINGLE-SELECT (the DEFAULT: ask.multiSelect falsy). This is
// the screenshot bug: "I only shared 4 ideas — which one did you mean?" is a
// one-answer question, but it rendered as checkboxes and let the user tick
// several, producing an incoherent joined answer. Single-select = radio
// buttons: picking an option REPLACES the prior pick; there's never more than
// one selection.
// ---------------------------------------------------------------------------

describe("toggleAskOption — single-select (default)", () => {
  const ask: AskQuestion = {
    question: "Which idea did you mean?",
    options: ["Idea 1", "Idea 2", "Idea 3", "Idea 4", "Use your best judgment"],
    allowOther: true,
    // no multiSelect → single-select
  };

  test("picking a second option REPLACES the first (never two at once)", () => {
    let sel: string[] = [];
    sel = toggleAskOption(ask, sel, "Idea 2");
    expect(sel).toEqual(["Idea 2"]);
    sel = toggleAskOption(ask, sel, "Idea 4");
    expect(sel).toEqual(["Idea 4"]); // the whole point — not ["Idea 2","Idea 4"]
  });

  test("clicking the already-selected option clears it (unpick)", () => {
    expect(toggleAskOption(ask, ["Idea 4"], "Idea 4")).toEqual([]);
  });

  test("the selection is at most one option across a long click sequence", () => {
    let sel: string[] = [];
    for (const opt of ["Idea 1", "Idea 3", "Idea 2", "Use your best judgment", "Idea 4"]) {
      sel = toggleAskOption(ask, sel, opt);
      expect(sel.length).toBeLessThanOrEqual(1);
    }
    expect(sel).toEqual(["Idea 4"]); // last pick wins
  });

  test("the let-me-decide escape behaves like any other single-select pick", () => {
    // With no doneOption (a pre-draft ask), the escape is just a normal option:
    // picking it is the sole selection and sends normally (resolveAskSubmission
    // only short-circuits to 'done' when it's the doneOption).
    let sel = ["Idea 2"];
    sel = toggleAskOption(ask, sel, "Use your best judgment");
    expect(sel).toEqual(["Use your best judgment"]);
    expect(resolveAskSubmission(ask, sel, "").kind).toBe("send");
  });
});
