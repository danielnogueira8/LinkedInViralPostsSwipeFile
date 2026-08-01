import type { PlanStep } from "@/lib/agent/contracts";

export function completeActivePlanSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) =>
    step.status === "active"
      ? { ...step, status: "done" as const }
      : step,
  );
}

export function advancePlanStep(
  steps: PlanStep[],
  step: Omit<PlanStep, "status">,
): PlanStep[] {
  return [
    ...completeActivePlanSteps(steps),
    { ...step, status: "active" as const },
  ];
}
