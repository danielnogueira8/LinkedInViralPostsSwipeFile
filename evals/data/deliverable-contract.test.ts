import { describe, expect, test } from "vitest";
import {
  deriveDeliverableContract,
  evaluateDeliverableArtifact,
} from "@/lib/agent/deliverable-contract";

describe("deriveDeliverableContract", () => {
  test("a hook request creates NO contract — hooks are text, not renderable cards", () => {
    // Hooks no longer render as cards (render_hook removed), so there's no
    // card-count contract to enforce for them.
    expect(deriveDeliverableContract("Give me 5 hooks about founder-led sales")).toBeNull();
    expect(deriveDeliverableContract("Draft 3 hooks for CEOs or founders")).toBeNull();
  });

  test("derives an exact post count from a word-number request", () => {
    expect(deriveDeliverableContract("Draft three post variations about churn")).toEqual({
      kind: "post",
      expectedCount: 3,
    });
  });

  test("does not reinterpret an ambiguous item reference as a quantity", () => {
    expect(deriveDeliverableContract("Draft 5")).toBeNull();
    expect(deriveDeliverableContract("Write number 2")).toBeNull();
  });

  test("does not contract unsupported or excessive counts", () => {
    expect(deriveDeliverableContract("Write 15 posts about onboarding")).toBeNull();
    expect(deriveDeliverableContract("Give me twenty posts")).toBeNull();
  });

  // The cap was raised 6 -> 10 after a real incident: "model 3 regular
  // posts" only rendered 1 because no contract existed at all for that
  // phrasing (see the modeling-verb test below); while fixing that, the
  // count ceiling itself was widened so a request up to 10 posts is tracked
  // and enforced instead of silently falling back to no contract.
  test("contracts counts up through the raised ceiling of 10", () => {
    expect(deriveDeliverableContract("Write 10 posts about onboarding")).toEqual({
      kind: "post",
      expectedCount: 10,
    });
    expect(deriveDeliverableContract("Give me seven posts")).toEqual({
      kind: "post",
      expectedCount: 7,
    });
  });

  test("does not turn negated or explanatory mentions into generation contracts", () => {
    expect(deriveDeliverableContract("Don't write 5 posts")).toBeNull();
    expect(deriveDeliverableContract("Can you explain how to write 5 posts?")).toBeNull();
    expect(deriveDeliverableContract("If I ask you to write 5 posts, push back")).toBeNull();
  });

  test("does not lock onto the first clause of a corrected or alternative request", () => {
    expect(deriveDeliverableContract("Write 5 posts—or actually, make that 2")).toBeNull();
    expect(deriveDeliverableContract("Draft 3 hooks or 2 posts")).toBeNull();
    expect(deriveDeliverableContract("Write 5 posts? No, just explain the format")).toBeNull();
    expect(deriveDeliverableContract("Write 5 posts, make that 2")).toBeNull();
    expect(deriveDeliverableContract("Write 5 posts, change that to 2")).toBeNull();
  });

  test("keeps a POST contract when or/don't belong only to the topic or constraints", () => {
    expect(
      deriveDeliverableContract("Write 3 posts for CEOs or founders"),
    ).toEqual({ kind: "post", expectedCount: 3 });
    expect(
      deriveDeliverableContract("Write 5 posts about onboarding; don't use em dashes"),
    ).toEqual({ kind: "post", expectedCount: 5 });
  });

  test("leaves compound cross-kind requests to multi-deliverable orchestration", () => {
    expect(
      deriveDeliverableContract("Give me one hook and turn it into a post"),
    ).toBeNull();
    expect(
      deriveDeliverableContract("Draft 2 hooks, then write the full post"),
    ).toBeNull();
  });

  // Regression: "model 3 regular posts" narrated fetching/rewriting all 3 but
  // only ever rendered 1 — because the "model" verb family (model/mimic/
  // adapt/rewrite/rework/remix, the same set source-policy.ts and run.ts's
  // SIMPLE_DRAFT_ACTION_RE already treat as drafting actions) was absent from
  // this count-extraction regex, so no contract existed to enforce the count
  // or trigger the in-loop "you still owe N more" nudge.
  test("derives a contract for the modeling-verb family, not just write/draft/create", () => {
    expect(deriveDeliverableContract("Model 3 regular posts")).toEqual({
      kind: "post",
      expectedCount: 3,
    });
    expect(deriveDeliverableContract("Mimic 2 posts")).toEqual({
      kind: "post",
      expectedCount: 2,
    });
    expect(deriveDeliverableContract("Adapt 3 posts for me")).toEqual({
      kind: "post",
      expectedCount: 3,
    });
    expect(deriveDeliverableContract("Rework 4 distinct posts")).toEqual({
      kind: "post",
      expectedCount: 4,
    });
  });
});

describe("evaluateDeliverableArtifact", () => {
  const contract = { kind: "post" as const, expectedCount: 3 };

  test("accepts matching post artifacts until the exact count is complete", () => {
    expect(evaluateDeliverableArtifact(contract, 1, "post")).toEqual({
      accept: true,
    });
    expect(evaluateDeliverableArtifact(contract, 2, "post")).toEqual({
      accept: true,
    });
  });

  test("rejects post artifacts beyond the requested count", () => {
    expect(evaluateDeliverableArtifact(contract, 3, "post")).toEqual({
      accept: false,
      reason: "count_complete",
    });
  });
});
