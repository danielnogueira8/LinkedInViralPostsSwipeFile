import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");
const planRoute = source("app/api/agent/week-plan/route.ts");
const draftRoute = source("app/api/agent/week-plan/draft/route.ts");
const itemRoute = source("app/api/agent/week-plan/items/[id]/route.ts");
const opportunityRoute = source("app/api/agent/opportunities/[id]/route.ts");
const briefing = source("app/(app)/dashboard/agent-briefing.tsx");
const migration = source("db/migration-124-persistent-week-plans.sql");

describe("persistent weekly plan contract", () => {
  test("stores one Monday-through-Sunday plan per workspace", () => {
    expect(migration).toContain("agent_week_plans");
    expect(migration).toContain("agent_week_plan_items");
    expect(migration).toContain("unique (workspace_id, week_start)");
    expect(migration).toContain("slot_index between 0 and 6");
    expect(migration).toContain("create_agent_week_plan");
    expect(planRoute).toContain("weekStart()");
    expect(planRoute).toContain("workWeekDays");
    expect(planRoute).toContain("agent_week_plan_items");
    expect(planRoute).toContain('.rpc(\n        "create_agent_week_plan"');
  });

  test("loads automatically and renders every day in one expanded row", () => {
    expect(briefing).toContain("void loadWeekPlan()");
    expect(briefing).not.toContain("Plan my week");
    expect(briefing).toContain("xl:grid-cols-7");
    expect(briefing).toContain("Your plan stays here all week");
  });

  test("generic cards need and persist real user context", () => {
    expect(briefing).toContain("context.trim().length < 12");
    expect(briefing).toContain("genericContextPlaceholder");
    expect(briefing).toContain("/api/agent/week-plan/items/${itemId}");
    expect(briefing).toContain("Add the real context");
    expect(itemRoute).toContain('.eq("kind", "generic")');
    expect(itemRoute).toContain("user_context: context || null");
  });

  test("the drafting endpoint claims a card once and keeps generic facts grounded", () => {
    expect(draftRoute).toContain("itemId");
    expect(draftRoute).toContain('.eq("status", "planned")');
    expect(draftRoute).toContain("userContext.trim().length < 12");
    expect(draftRoute).toContain("draftFromPrompt");
    expect(draftRoute).toContain("actOnOpportunity");
    expect(draftRoute).toContain("await restore();");
  });

  test("normal opportunity actions update their matching persistent card", () => {
    expect(opportunityRoute).toContain("agent_week_plan_items");
    expect(opportunityRoute).toContain("status: \"dismissed\"");
    expect(opportunityRoute).toContain("drafted_artifact_id: result.draftIds[0]");
  });
});
