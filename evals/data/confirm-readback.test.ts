import { describe, expect, test } from "vitest";
import { summarize, chips } from "@/app/(app)/dashboard/confirm-readback";
import type { TurnDecision } from "@/lib/agent/turn/resolve-decision";

// The read-back's plain-language summary + chips are what the user reads before
// committing a turn, so their copy logic is locked here.

function decision(overrides: Partial<TurnDecision> = {}): TurnDecision {
  return {
    mode: "create",
    postCount: 1,
    niche: null,
    postType: "regular",
    hasModelSource: false,
    hasCreatorStyle: false,
    hasLeadMagnetSelection: false,
    taskKind: "post",
    conflicts: [],
    route: { readOnly: null, contractKind: "post" },
    ...overrides,
  };
}

describe("confirm read-back summary", () => {
  test("a single regular post", () => {
    expect(summarize(decision())).toBe("Write 1 post.");
  });

  test("multiple posts pluralize", () => {
    expect(summarize(decision({ postCount: 3 }))).toBe("Write 3 posts.");
  });

  test("ideas across all niches", () => {
    const s = summarize(
      decision({ mode: "ask", taskKind: "ideas", postCount: 5, postType: null }),
    );
    expect(s).toBe("Brainstorm 5 post ideas across all your niches.");
  });

  test("ideas scoped to a real niche", () => {
    const s = summarize(
      decision({
        mode: "ask",
        taskKind: "ideas",
        postCount: 3,
        niche: "SaaS",
        postType: null,
      }),
    );
    expect(s).toBe("Brainstorm 3 post ideas in your SaaS niche.");
  });

  test("a lead-magnet post reads as such", () => {
    expect(summarize(decision({ postType: "lead_magnet" }))).toBe(
      "Write 1 lead-magnet post.",
    );
  });

  test("a modeled post names the source", () => {
    expect(summarize(decision({ hasModelSource: true }))).toBe(
      "Write 1 post, modeled on your source post.",
    );
  });

  test("an edit reads as an edit", () => {
    expect(summarize(decision({ mode: "edit", taskKind: "post" }))).toContain(
      "Edit",
    );
  });
});

describe("confirm read-back chips", () => {
  test("always shows a Mode chip", () => {
    expect(chips(decision()).some((c) => c.label === "Mode")).toBe(true);
  });

  test("shows a Niche chip on an ideas turn (All niches when none)", () => {
    const c = chips(
      decision({ mode: "ask", taskKind: "ideas", niche: null }),
    ).find((chip) => chip.label === "Niche");
    expect(c?.value).toBe("All niches");
  });

  test("shows a Source chip when a model source is attached", () => {
    expect(
      chips(decision({ hasModelSource: true })).some((c) => c.label === "Source"),
    ).toBe(true);
  });

  test("shows a Count chip only when generating more than one", () => {
    expect(chips(decision({ postCount: 1 })).some((c) => c.label === "Count")).toBe(
      false,
    );
    expect(chips(decision({ postCount: 4 })).some((c) => c.label === "Count")).toBe(
      true,
    );
  });
});
