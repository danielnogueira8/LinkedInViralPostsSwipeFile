import { describe, test, expect } from "vitest";
import { PlanState, dispatchPlanTool } from "@/lib/agent/plan-state";
import type { PlanStep } from "@/lib/agent/contracts";

// ---------------------------------------------------------------------------
// Unit tests for the agent's task-plan state machine — the live checklist that
// write_plan / update_plan drive (lib/agent/run.ts). Pure logic, no I/O: we
// exercise PlanState directly and dispatchPlanTool (the loop's adapter that
// turns tool args into plan events + synthetic tool results).
// ---------------------------------------------------------------------------

const labelsOf = (steps: PlanStep[]) => steps.map((s) => s.label);
const statusesOf = (steps: PlanStep[]) => steps.map((s) => s.status);

describe("PlanState.setPlan — laying out the checklist", () => {
  test("trims, drops blanks, and marks the first step active", () => {
    const plan = new PlanState();
    const steps = plan.setPlan([
      "  Read your voice profile  ",
      "",
      "Search your swipe file",
      "   ",
      "Draft 3 posts",
    ]);
    expect(steps).not.toBeNull();
    expect(labelsOf(steps!)).toEqual([
      "Read your voice profile",
      "Search your swipe file",
      "Draft 3 posts",
    ]);
    // First step active, the rest pending.
    expect(statusesOf(steps!)).toEqual(["active", "pending", "pending"]);
    expect(plan.hasPlan).toBe(true);
  });

  test("caps at 8 steps and truncates over-long labels", () => {
    const plan = new PlanState();
    const many = Array.from({ length: 12 }, (_, i) => `Step number ${i}`);
    const steps = plan.setPlan([...many, "x".repeat(200)]);
    expect(steps!.length).toBe(8);
    for (const s of steps!) expect(s.label.length).toBeLessThanOrEqual(80);
  });

  test("rejects a non-array or all-empty step list (null → caller errors)", () => {
    const plan = new PlanState();
    expect(plan.setPlan("not an array")).toBeNull();
    expect(plan.setPlan([])).toBeNull();
    expect(plan.setPlan(["", "   ", 42, null])).toBeNull();
    expect(plan.hasPlan).toBe(false);
  });

  test("re-planning replaces the prior list with fresh ids (no stale steps)", () => {
    const plan = new PlanState();
    const first = plan.setPlan(["A", "B", "C"]);
    const second = plan.setPlan(["X", "Y"]);
    expect(labelsOf(second!)).toEqual(["X", "Y"]);
    // Ids differ across plans, so a client keyed on id can't show a stale row.
    expect(first![0].id).not.toBe(second![0].id);
    expect(statusesOf(second!)).toEqual(["active", "pending"]);
  });
});

describe("PlanState.applyUpdate — advancing the checklist", () => {
  test("marks completed steps done and moves the active marker", () => {
    const plan = new PlanState();
    plan.setPlan(["A", "B", "C"]);
    const steps = plan.applyUpdate([0], 1);
    expect(statusesOf(steps!)).toEqual(["done", "active", "pending"]);
  });

  test("only one step is active at a time", () => {
    const plan = new PlanState();
    plan.setPlan(["A", "B", "C"]);
    plan.applyUpdate([0], 1);
    const steps = plan.applyUpdate([0, 1], 2);
    expect(statusesOf(steps!)).toEqual(["done", "done", "active"]);
    expect(steps!.filter((s) => s.status === "active")).toHaveLength(1);
  });

  test("out-of-range indices are ignored (model miscount is harmless)", () => {
    const plan = new PlanState();
    plan.setPlan(["A", "B"]);
    const steps = plan.applyUpdate([5, -1, 0], 9);
    // 0 completed; the bogus active index 9 leaves the markers otherwise intact.
    expect(statusesOf(steps!)).toEqual(["done", "pending"]);
  });

  test("a step already done stays done even if named active", () => {
    const plan = new PlanState();
    plan.setPlan(["A", "B"]);
    plan.applyUpdate([0], 1);
    // Try to re-activate the completed step 0 — it must remain done.
    const steps = plan.applyUpdate([], 0);
    expect(steps![0].status).toBe("done");
  });

  test("update before any plan returns null (nothing to update)", () => {
    const plan = new PlanState();
    expect(plan.applyUpdate([0], 0)).toBeNull();
  });
});

describe("PlanState.finalize — closing out the turn", () => {
  test("marks every unfinished step done and reports the change", () => {
    const plan = new PlanState();
    plan.setPlan(["A", "B", "C"]);
    plan.applyUpdate([0], 1);
    const steps = plan.finalize();
    expect(statusesOf(steps!)).toEqual(["done", "done", "done"]);
  });

  test("returns null when there's nothing to change (all done, or no plan)", () => {
    const empty = new PlanState();
    expect(empty.finalize()).toBeNull();

    const plan = new PlanState();
    plan.setPlan(["A"]);
    plan.applyUpdate([0], 0); // already all done
    expect(plan.finalize()).toBeNull();
  });
});

describe("dispatchPlanTool — the loop adapter", () => {
  test("write_plan emits a plan event + an ok result", () => {
    const plan = new PlanState();
    const { result, event } = dispatchPlanTool(
      "write_plan",
      { steps: ["A", "B"] },
      plan,
    );
    expect(result.ok).toBe(true);
    expect(event?.type).toBe("plan");
    expect(event && "steps" in event && labelsOf(event.steps)).toEqual(["A", "B"]);
  });

  test("write_plan with bad args returns ok:false and no event", () => {
    const plan = new PlanState();
    const { result, event } = dispatchPlanTool("write_plan", { steps: [] }, plan);
    expect(result.ok).toBe(false);
    expect(event).toBeNull();
    expect(plan.hasPlan).toBe(false);
  });

  test("update_plan emits a plan_update against the existing plan", () => {
    const plan = new PlanState();
    dispatchPlanTool("write_plan", { steps: ["A", "B", "C"] }, plan);
    const { result, event } = dispatchPlanTool(
      "update_plan",
      { completed: [0], active: 1 },
      plan,
    );
    expect(result.ok).toBe(true);
    expect(event?.type).toBe("plan_update");
    expect(event && "steps" in event && statusesOf(event.steps)).toEqual([
      "done",
      "active",
      "pending",
    ]);
  });

  test("update_plan before write_plan errors back (no plan yet)", () => {
    const plan = new PlanState();
    const { result, event } = dispatchPlanTool(
      "update_plan",
      { completed: [0] },
      plan,
    );
    expect(result.ok).toBe(false);
    expect(event).toBeNull();
  });

  test("malformed JSON args (null) error back without throwing", () => {
    const plan = new PlanState();
    const { result, event } = dispatchPlanTool("write_plan", null, plan);
    expect(result.ok).toBe(false);
    expect(event).toBeNull();
  });
});
