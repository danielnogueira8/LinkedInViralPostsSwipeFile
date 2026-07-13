import type { AgentEvent, PlanStep } from "@/lib/agent/contracts";

export const PLAN_TOOL_NAMES = new Set<string>(["write_plan", "update_plan"]);
const MAX_PLAN_STEPS = 8;
const MAX_PLAN_LABEL_LEN = 80;

export class PlanState {
  private steps: PlanStep[] = [];
  private seq = 0;

  get hasPlan(): boolean {
    return this.steps.length > 0;
  }

  snapshot(): PlanStep[] {
    return this.steps.map((step) => ({ ...step }));
  }

  setPlan(rawSteps: unknown): PlanStep[] | null {
    if (!Array.isArray(rawSteps)) return null;
    const labels = rawSteps
      .map((step) => (typeof step === "string" ? step.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_PLAN_STEPS)
      .map((step) => step.slice(0, MAX_PLAN_LABEL_LEN));
    if (labels.length === 0) return null;
    this.steps = labels.map((label, index) => ({
      id: `step_${this.seq}_${index}`,
      label,
      status: index === 0 ? "active" : "pending",
    }));
    this.seq++;
    return this.snapshot();
  }

  applyUpdate(completed: unknown, active: unknown): PlanStep[] | null {
    if (this.steps.length === 0) return null;
    const inRange = (value: unknown): value is number =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value < this.steps.length;
    const completedSet = new Set(
      (Array.isArray(completed) ? completed : []).filter(inRange),
    );
    this.steps.forEach((step, index) => {
      if (completedSet.has(index)) step.status = "done";
    });
    if (inRange(active) && this.steps[active].status !== "done") {
      for (const step of this.steps) {
        if (step.status === "active") step.status = "pending";
      }
      this.steps[active].status = "active";
    }
    // The model can omit or miscount `active` after completing the current
    // step. Keep the UI feedback continuous by restoring the state invariant:
    // unfinished work always has exactly one active step.
    if (!this.steps.some((step) => step.status === "active")) {
      const next = this.steps.find((step) => step.status === "pending");
      if (next) next.status = "active";
    }
    return this.snapshot();
  }

  finalize(): PlanStep[] | null {
    if (this.steps.length === 0) return null;
    let changed = false;
    for (const step of this.steps) {
      if (step.status !== "done") {
        step.status = "done";
        changed = true;
      }
    }
    return changed ? this.snapshot() : null;
  }
}

export function dispatchPlanTool(
  name: string,
  parsedArgs: Record<string, unknown> | null,
  plan: PlanState,
): { result: Record<string, unknown>; event: AgentEvent | null } {
  if (parsedArgs === null) {
    return {
      result: {
        ok: false,
        error:
          "Your tool arguments were not valid JSON. Re-issue the call with well-formed JSON arguments.",
      },
      event: null,
    };
  }
  if (name === "write_plan") {
    const steps = plan.setPlan(parsedArgs.steps);
    return steps
      ? {
          result: { ok: true, planned: steps.length },
          event: { type: "plan", steps },
        }
      : {
          result: {
            ok: false,
            error:
              'write_plan requires a non-empty "steps" array of short label strings (2-6 steps).',
          },
          event: null,
        };
  }
  if (name === "update_plan") {
    const steps = plan.applyUpdate(parsedArgs.completed, parsedArgs.active);
    return steps
      ? { result: { ok: true }, event: { type: "plan_update", steps } }
      : {
          result: {
            ok: false,
            error: "No plan to update yet — call write_plan first to lay out the steps.",
          },
          event: null,
        };
  }
  return {
    result: { ok: false, error: `Unknown plan tool: ${name}` },
    event: null,
  };
}
