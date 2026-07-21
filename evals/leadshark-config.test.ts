import { describe, test, expect } from "vitest";
import {
  validateAutomationConfig,
  unknownTemplateVars,
  containsUrl,
  defaultDmTemplate,
  ALLOWED_TEMPLATE_VARS,
  type AutomationConfigDraft,
} from "@/lib/leadshark-config";

// ---------------------------------------------------------------------------
// Automation config validation (build plan §5.4). Pure. These rules are the
// authoritative server-side gate; the panel mirrors them.
// ---------------------------------------------------------------------------

function cfg(p: Partial<AutomationConfigDraft>): AutomationConfigDraft {
  return {
    keywords: [],
    dmTemplate: "Hey {{firstName}}, here's the guide: https://x/lm/y",
    dmTemplateVariations: [],
    commentReplyTemplates: [],
    nonConnectionReplyTemplates: [],
    autoConnect: false,
    autoLike: false,
    followUpEnabled: false,
    followUpTemplate: null,
    followUpDelayMinutes: 60,
    followUpOnlyIfNoResponse: true,
    ...p,
  };
}

describe("validateAutomationConfig", () => {
  test("a well-formed config passes with no issues", () => {
    expect(validateAutomationConfig(cfg({}))).toEqual([]);
  });

  test("blank keywords are VALID (means every comment)", () => {
    expect(validateAutomationConfig(cfg({ keywords: [] }))).toEqual([]);
  });

  test("DM is required", () => {
    const issues = validateAutomationConfig(cfg({ dmTemplate: "   " }));
    expect(issues.some((i) => i.field === "dmTemplate")).toBe(true);
  });

  test("DM over 2000 chars is rejected", () => {
    const issues = validateAutomationConfig(cfg({ dmTemplate: "a".repeat(2001) }));
    expect(issues.some((i) => i.field === "dmTemplate")).toBe(true);
  });

  test("more than 20 keywords is rejected", () => {
    const issues = validateAutomationConfig(
      cfg({ keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }),
    );
    expect(issues.some((i) => i.field === "keywords")).toBe(true);
  });

  test("follow-up on requires a template", () => {
    const issues = validateAutomationConfig(
      cfg({ followUpEnabled: true, followUpTemplate: null }),
    );
    expect(issues.some((i) => i.field === "followUpTemplate")).toBe(true);
  });

  test("follow-up on with a template passes", () => {
    expect(
      validateAutomationConfig(
        cfg({ followUpEnabled: true, followUpTemplate: "Hey {{firstName}}, following up." }),
      ),
    ).toEqual([]);
  });

  test("an unsupported {{variable}} is rejected", () => {
    // {{lastName}} is shown in LeadShark's dashboard but NOT in the API ref, so
    // we refuse it (an unsubstituted one would reach a real prospect).
    const issues = validateAutomationConfig(
      cfg({ dmTemplate: "Hi {{firstName}} {{lastName}}" }),
    );
    expect(issues.some((i) => i.field === "template")).toBe(true);
    expect(issues.find((i) => i.field === "template")?.message).toContain("{{lastName}}");
  });

  test("all four documented variables are allowed", () => {
    const dm = ALLOWED_TEMPLATE_VARS.map((v) => `{{${v}}}`).join(" ") + " https://x";
    expect(validateAutomationConfig(cfg({ dmTemplate: dm }))).toEqual([]);
  });
});

describe("helpers", () => {
  test("unknownTemplateVars returns only the disallowed ones", () => {
    expect(unknownTemplateVars(["Hi {{firstName}} {{lastName}}", "{{company}}"])).toEqual([
      "lastName",
      "company",
    ]);
    expect(unknownTemplateVars(["{{fullName}}", null, undefined])).toEqual([]);
  });

  test("containsUrl detects a link or a {{url}} token", () => {
    expect(containsUrl("grab it at https://x/lm/y")).toBe(true);
    expect(containsUrl("here: {{url}}")).toBe(true);
    expect(containsUrl("no link here")).toBe(false);
  });

  test("defaultDmTemplate embeds the title and url", () => {
    const t = defaultDmTemplate("Cold Email Playbook", "https://host/lm/abc");
    expect(t).toContain("Cold Email Playbook");
    expect(t).toContain("https://host/lm/abc");
    expect(t).toContain("{{firstName}}");
  });
});
