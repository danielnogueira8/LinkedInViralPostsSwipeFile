import { describe, test, expect } from "vitest";
import { shouldShowActivityRail } from "@/lib/chat-ui-policy";

// ---------------------------------------------------------------------------
// The activity-rail gating rule (chat-workspace.tsx). When the agent's plan
// checklist is present it's the sole progress surface — the per-tool rail is
// hidden so the two don't narrate the same work twice. Exception: a FAILED tool
// must stay visible (the plan card has no failure state).
// ---------------------------------------------------------------------------

type Step = { id: string; label: string; status: "pending" | "active" | "done" };
type Chip = { id: string; name: string; args?: string; ok?: boolean };

const step = (status: Step["status"]): Step => ({ id: "s", label: "x", status });
const tool = (ok?: boolean): Chip => ({ id: "t", name: "get_voice", ok });

describe("shouldShowActivityRail", () => {
  test("no tools → never show the rail", () => {
    expect(shouldShowActivityRail([], [])).toBe(false);
    expect(shouldShowActivityRail([step("active")], [])).toBe(false);
  });

  test("tools but NO plan → show the rail (one-shot turn, unchanged behavior)", () => {
    expect(shouldShowActivityRail([], [tool(undefined)])).toBe(true);
    expect(shouldShowActivityRail([], [tool(true)])).toBe(true);
  });

  test("plan present + all tools fine → hide the rail (plan is the sole surface)", () => {
    const plan = [step("done"), step("active"), step("pending")];
    expect(shouldShowActivityRail(plan, [tool(true)])).toBe(false);
    expect(shouldShowActivityRail(plan, [tool(undefined), tool(true)])).toBe(false);
  });

  test("plan present + a FAILED tool → keep the rail (plan card can't show failure)", () => {
    const plan = [step("active")];
    expect(shouldShowActivityRail(plan, [tool(true), tool(false)])).toBe(true);
    expect(shouldShowActivityRail(plan, [tool(false)])).toBe(true);
  });

  test("the desync bug case: plan + a running tool → rail hidden (no double narration)", () => {
    // This is the screenshot: a plan card showing 'Read your voice profile'
    // active while the rail below also shows it. With the gate, the rail is gone.
    const plan = [step("active"), step("pending")];
    const tools = [tool(true), tool(undefined)]; // one done, one running
    expect(shouldShowActivityRail(plan, tools)).toBe(false);
  });
});
