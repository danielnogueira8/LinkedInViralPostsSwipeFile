import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");
const planRoute = source("app/api/agent/week-plan/route.ts");
const draftRoute = source("app/api/agent/week-plan/draft/route.ts");
const itemRoute = source("app/api/agent/week-plan/items/[id]/route.ts");
const rerollRoute = source(
  "app/api/agent/week-plan/items/[id]/reroll/route.ts",
);
const opportunityRoute = source("app/api/agent/opportunities/[id]/route.ts");
const briefing = source("app/(app)/dashboard/agent-briefing.tsx");
const postCard = source("components/post-card.tsx");
const act = source("lib/agent-loop/act.ts");
const migration = source("db/migration-124-persistent-week-plans.sql");
const store = source("lib/agent-loop/week-plan-store.ts");

describe("persistent weekly plan contract", () => {
  test("stores one Monday-through-Sunday plan per workspace", () => {
    expect(migration).toContain("agent_week_plans");
    expect(migration).toContain("agent_week_plan_items");
    expect(migration).toContain("unique (workspace_id, week_start)");
    expect(migration).toContain("slot_index between 0 and 6");
    expect(migration).toContain("create_agent_week_plan");
    expect(planRoute).toContain("weekStart()");
    expect(planRoute).toContain("workWeekDays");
    expect(store).toContain("agent_week_plan:");
    expect(store).toContain('.from("settings").insert(');
    expect(store).toContain('.eq("updated_at", snapshot.updatedAt)');
    expect(planRoute).toContain("loadStoredWeekPlan");
    expect(planRoute).toContain("createStoredWeekPlan");
    expect(planRoute).not.toContain("agent_week_plans");
  });

  test("loads automatically and renders every day in one expanded row", () => {
    expect(briefing).toContain("void loadWeekPlan()");
    expect(briefing).not.toContain("Plan my week");
    expect(briefing).toContain("lg:grid-cols-7");
    expect(briefing).toContain("This week&apos;s cadence");
  });

  test("the weekly cadence remains visible when persistence is unavailable", () => {
    expect(briefing).not.toContain("{weekPlan && (");
    expect(briefing).not.toContain("if (!briefing) return null");
    expect(briefing).toContain("EMPTY_BRIEFING");
    expect(briefing).toContain("weekPlanError");
    expect(briefing).toContain("Retry");
  });

  test("generic cards need and persist real user context", () => {
    expect(briefing).toContain("getWeekPlanDraftReadiness");
    expect(briefing).toContain("genericContextPlaceholder");
    expect(briefing).toContain(
      "/api/agent/week-plan/items/${requiredInputItem.id}",
    );
    expect(briefing).toContain("Choose direction");
    expect(itemRoute).toContain("mutateStoredWeekPlanItem");
    expect(itemRoute).toContain("selectedLeadMagnetId");
  });

  test("the drafting endpoint claims a card once and keeps generic facts grounded", () => {
    expect(draftRoute).toContain("itemId");
    expect(draftRoute).toContain('item.status !== "planned"');
    expect(draftRoute).toContain("readiness.needsContext");
    expect(draftRoute).toContain("draftFromPrompt");
    expect(draftRoute).toContain("actOnOpportunity");
    expect(draftRoute).toContain('await updateStatus("planned", "drafting")');
    expect(draftRoute).toContain('updateStatus("drafting", "planned")');
    expect(draftRoute).toContain("leadMagnetId");
    expect(draftRoute).toContain(
      'updateStatus("drafted", "drafting", result.draftIds[0])',
    );
    expect(store).toContain("draftId: z.string().uuid().nullable().optional()");
    expect(act).toContain('command: { kind: "create", count: 1 }');
    expect(draftRoute).toContain("Your direction is saved");
    expect(draftRoute).toContain("{ status: 502 }");
    expect(briefing).toContain('role="alert"');
  });

  test("a completed cadence card opens its exact saved draft on the Posts board", () => {
    expect(briefing).toContain('"See Draft"');
    expect(briefing).not.toContain('"Draft saved"');
    expect(briefing).toContain(
      "`/dashboard/posts?open=${encodeURIComponent(item.draftId)}`",
    );
    expect(briefing).toContain(
      'item.status === "drafted" && Boolean(item.draftId)',
    );
    expect(planRoute).toContain("recoverLegacyDraftIds");
    expect(planRoute).toContain("drafted_artifact_id");
    expect(planRoute).toContain("findLegacyGenericDraftId");
  });

  test("normal opportunity actions update their matching persistent card", () => {
    expect(opportunityRoute).toContain("markStoredOpportunityDrafted");
    expect(opportunityRoute).toContain('"drafted"');
    expect(store).toContain("markStoredOpportunityDrafted");
    expect(store).toContain('status: "drafted"');
  });

  test("dismissing an agent-feed opportunity does not skip its weekly cadence card", () => {
    const dismissBranch = opportunityRoute.slice(
      opportunityRoute.indexOf('if (action === "dismiss")'),
      opportunityRoute.indexOf('if (opportunity.status !== "proposed")'),
    );
    expect(dismissBranch).not.toContain("markStoredOpportunityDrafted");
    expect(dismissBranch).toContain('status: "dismissed"');
    expect(planRoute).toContain("restoreLegacyDismissedOpportunityItems");
    expect(store).toContain("restoreLegacyDismissedOpportunityItems");
    expect(draftRoute).toContain('opportunity.status === "dismissed"');
    expect(draftRoute).toContain('"preserve" : "manage"');
    expect(act).toContain("OpportunityStatusPolicy");
    expect(act).toContain('if (policy === "preserve") return');
    expect(act.match(/if \(policy === "preserve"\)/g)).toHaveLength(1);
  });

  test("direction opens in a right-side panel and lead magnets choose a resource", () => {
    expect(briefing).toContain("!right-0");
    expect(briefing).toContain("Resource to promote");
    expect(briefing).toContain("/api/lead-magnets");
    expect(briefing).toContain("requiredInputLeadMagnetId");
    expect(briefing).toContain('"Choose resource"');
    expect(briefing).toContain('"Ready for draft"');
    expect(briefing).not.toContain('"Source ready"');
  });

  test("modeled cadence posts expose the complete source in the review drawer", () => {
    expect(planRoute).toContain("normalizeAgentSourcePost");
    expect(planRoute).toContain("SWIPE_POST_COLS");
    expect(planRoute).toContain("source_post");
    expect(briefing).toContain('"Review source"');
    expect(briefing).toContain(
      "post={requiredInputItem.opportunity.source_post}",
    );
    expect(briefing).toContain("showDefaultActions={false}");
    expect(briefing).toContain("Draft this");
    expect(postCard).toContain("textLong");
    expect(postCard).toContain("clampClass");
    expect(postCard).toContain("<ExpandTextButton");
  });

  test("input progress excludes skipped slots and uses one readiness rule", () => {
    expect(briefing).not.toContain("function directionFieldsReady(");
    expect(briefing).not.toContain("function itemHasDirection(");
    expect(briefing).toContain("getWeekPlanDraftReadiness");
    expect(briefing).toContain('item.status !== "dismissed"');
    expect(briefing).toContain("!itemDraftReadiness(item).ready");
  });

  test("cadence completion advances only after a draft exists", () => {
    expect(briefing).toContain("cadenceDraftProgress(planItems)");
    expect(briefing).toContain("draftProgress.drafted");
    expect(briefing).not.toContain(
      'item.status === "drafted" || itemDraftReadiness(item).ready',
    );
  });

  test("modeled posts skip direction while lead magnets require only a resource", () => {
    expect(draftRoute).toContain("getWeekPlanDraftReadiness");
    expect(draftRoute).toContain("resolveWeekPlanLeadMagnetId");
    expect(draftRoute).toContain("readiness.needsLeadMagnet");
    expect(draftRoute).not.toContain("context.length < 12");
    expect(briefing).toContain("requiredInputItem?.kind === \"generic\"");
    expect(briefing).toContain("requiredInputItem?.opportunity?.is_lead_magnet");
    expect(briefing).toContain(
      '...(item.kind === "generic" ? { context } : {})',
    );
    expect(briefing).toContain("item.opportunity?.is_lead_magnet");
    expect(draftRoute).toContain(
      'userContext: item.kind === "generic" ? context : null',
    );
  });

  test("weekly-cadence lead magnets are saved as lead_magnet drafts, not regular posts", () => {
    expect(act).toContain('kind: isLeadMagnet ? "lead_magnet" : "post"');
    expect(act).not.toContain('kind: "post",');
    expect(act).toContain(
      "Boolean(body.leadMagnetId || body.createLeadMagnet)",
    );
  });

  test("the four weekly-cadence CTA steps use distinct white/black/coral colors", () => {
    expect(briefing).toContain("type CadenceCtaVariant");
    expect(briefing).toContain(
      'white:\n    "border border-border bg-card text-foreground hover:border-accent-brand/40"',
    );
    expect(briefing).toContain(
      'black: "bg-foreground text-background hover:bg-foreground/90"',
    );
    expect(briefing).toContain(
      'coral: "bg-accent-brand text-accent-brand-foreground hover:bg-accent-brand/90"',
    );
    expect(briefing).toContain("function cadenceCtaVariant(");
    expect(briefing).toContain(
      "CADENCE_CTA_CLASSNAMES[cadenceCtaVariant(item, readiness)]",
    );
    expect(briefing).toContain("CADENCE_CTA_CLASSNAMES.black");
  });

  test("a drafted cadence card shows a green check next to its day", () => {
    expect(briefing).toContain("CheckCircle2");
    expect(briefing).toContain('item.status === "drafted" ? (');
    expect(briefing).toContain("text-state-success");
  });

  test("planned cadence cards can be refreshed for a different post or idea", () => {
    expect(briefing).toContain("RefreshCcw");
    expect(briefing).toContain("rerollPlanItem");
    expect(briefing).toContain(
      '/api/agent/week-plan/items/${item.id}/reroll',
    );
    expect(briefing).toContain('item.status === "planned" ? (');

    expect(rerollRoute).toContain("export async function POST(");
    expect(rerollRoute).toContain('status !== "planned"');
    // Same kind of opportunity (lead magnet vs. regular) as the slot it replaces.
    expect(rerollRoute).toContain(
      "current.opportunity?.is_lead_magnet === true",
    );
    expect(rerollRoute).toContain("opportunityIsLeadMagnet(row, leadMagnetPostIdSet) === wantLeadMagnet");
    // Never re-picks an opportunity already showing elsewhere on the plan.
    expect(rerollRoute).toContain("usedOpportunityIds(resolved.plan.items)");
    // Generic ("idea") slots swap prompts instead of opportunities.
    expect(rerollRoute).toContain("pickNextGenericPrompt(");
    expect(rerollRoute).toContain('item.status !== "planned"');
    expect(rerollRoute).toContain("resolveStoredWeekPlanItemAcross");
    expect(rerollRoute).toContain('recovery: "reload_week_plan"');
    expect(briefing).toContain('data?.recovery === "reload_week_plan"');
    expect(briefing).toContain("await loadWeekPlan()");
    expect(rerollRoute).not.toContain(
      "This card is no longer available to refresh.",
    );
  });

  test("weekly recommendations use active learning as an explainable, overridable nudge", () => {
    expect(planRoute).toContain("loadActiveWorkspaceLearning");
    expect(planRoute).toContain("rankWeekPlanOpportunities");
    expect(planRoute).toContain("rankGenericWeekPrompts");
    expect(store).toContain("learningSource");
    expect(briefing).toContain("Guided by your Voice");
    expect(briefing).toContain("Guided by published results");
    expect(rerollRoute).toContain("rankWeekPlanOpportunities");
    expect(rerollRoute).toContain("rankGenericWeekPrompts");

    // Learning chooses recommendations; explicit direction and resource
    // selections remain the authoritative drafting inputs.
    expect(draftRoute).toContain(
      "const context = (input.context ?? item.userContext ?? \"\").trim()",
    );
    expect(draftRoute).toContain("requestedLeadMagnetId: input.leadMagnetId");
    expect(draftRoute).toContain("draftFromPrompt(");
    expect(draftRoute).toContain("actOnOpportunity(");
  });
});
