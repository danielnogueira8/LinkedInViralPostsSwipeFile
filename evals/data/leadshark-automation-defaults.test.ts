import { describe, expect, test } from "vitest";
import {
  RESOURCE_NAME_TOKEN,
  RESOURCE_URL_TOKEN,
  defaultLeadSharkAutomationDefaults,
  materializeLeadSharkAutomationDefaults,
  validateLeadSharkAutomationDefaults,
} from "@/lib/leadshark-default-config";

describe("LeadShark automation defaults", () => {
  test("materializes the current lead magnet without persisting a stale resource", () => {
    const defaults = defaultLeadSharkAutomationDefaults();
    const result = materializeLeadSharkAutomationDefaults(defaults, {
      name: "Founder playbook",
      url: "https://tryswipein.com/lm/founder-playbook",
    });

    expect(defaults.dmTemplate).toContain(RESOURCE_URL_TOKEN);
    expect(defaults.dmTemplate).toContain(RESOURCE_NAME_TOKEN);
    expect(result.dmTemplate).toContain("Founder playbook");
    expect(result.dmTemplate).toContain(
      "https://tryswipein.com/lm/founder-playbook",
    );
    expect(result.dmTemplate).not.toContain("{{resource");
  });

  test("requires every rotated DM to include the dynamic resource link", () => {
    const defaults = defaultLeadSharkAutomationDefaults();
    expect(validateLeadSharkAutomationDefaults(defaults)).toEqual([]);

    expect(
      validateLeadSharkAutomationDefaults({
        ...defaults,
        dmTemplateVariations: ["Hey {{firstName}}, here you go."],
      }),
    ).toContainEqual({
      field: "dmTemplateVariations",
      message: "Every DM variation must include {{resourceUrl}}.",
    });
  });
});
