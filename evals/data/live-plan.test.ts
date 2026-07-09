import { describe, test, expect } from "vitest";
import { normalizeLivePlan } from "@/app/(app)/dashboard/chat-workspace";

// normalizeLivePlan validates the untrusted-shaped chats.live_plan JSONB into a
// clean PlanStep[] so a reattaching client can re-render the checklist safely.
describe("normalizeLivePlan", () => {
  test("passes through well-formed steps", () => {
    const steps = [
      { id: "s1", label: "Find source posts", status: "done" },
      { id: "s2", label: "Draft the post", status: "active" },
      { id: "s3", label: "Final check", status: "pending" },
    ];
    expect(normalizeLivePlan(steps)).toEqual(steps);
  });

  test("non-array input → empty plan", () => {
    expect(normalizeLivePlan(null)).toEqual([]);
    expect(normalizeLivePlan(undefined)).toEqual([]);
    expect(normalizeLivePlan("nope")).toEqual([]);
    expect(normalizeLivePlan({})).toEqual([]);
  });

  test("drops malformed steps (missing id/label or bad status)", () => {
    const raw = [
      { id: "ok", label: "Keep me", status: "pending" },
      { id: "x", label: "Bad status", status: "spinning" },
      { id: "y", status: "done" }, // no label
      { label: "no id", status: "done" },
      null,
      "string",
      42,
    ];
    expect(normalizeLivePlan(raw)).toEqual([
      { id: "ok", label: "Keep me", status: "pending" },
    ]);
  });

  test("an empty array → empty plan (no checklist rendered)", () => {
    expect(normalizeLivePlan([])).toEqual([]);
  });
});
