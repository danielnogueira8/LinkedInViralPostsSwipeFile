import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadSharkCard } from "@/app/(app)/dashboard/integrations/leadshark-card";
import {
  RESOURCE_NAME_TOKEN,
  RESOURCE_URL_TOKEN,
  defaultLeadSharkAutomationDefaults,
  materializeLeadSharkAutomationDefaults,
  validateLeadSharkAutomationDefaults,
} from "@/lib/leadshark-default-config";

describe("LeadShark automation defaults", () => {
  test("shows the default messages for a connected account during schema rollout", () => {
    const html = renderToStaticMarkup(
      createElement(LeadSharkCard, {
        initial: {
          connected: true,
          status: "active",
          keyHint: "••••ef79",
          lastVerifiedAt: "2026-07-21T10:00:00.000Z",
          lastError: null,
        },
        initialDefaults: defaultLeadSharkAutomationDefaults(),
        defaultsAvailable: false,
      }),
    );

    expect(html).toContain("Automation defaults");
    expect(html).toContain("Default DM");
    expect(html).not.toContain("Trigger keywords");
    expect(html).toContain(RESOURCE_URL_TOKEN);
    expect(html).toContain("Saving changes will be available");
  });

  test("materializes the current lead magnet without persisting a stale resource", () => {
    const defaults = defaultLeadSharkAutomationDefaults();
    defaults.keywords = ["STALE"];
    const result = materializeLeadSharkAutomationDefaults(defaults, {
      name: "Founder playbook",
      url: "https://tryswipein.com/lm/founder-playbook",
      keyword: "PLAYBOOK",
    });

    expect(result.keywords).toEqual(["PLAYBOOK"]);
    expect(defaults.dmTemplate).toContain(RESOURCE_URL_TOKEN);
    expect(defaults.dmTemplate).toContain(RESOURCE_NAME_TOKEN);
    expect(result.dmTemplate).toContain("Founder playbook");
    expect(result.dmTemplate).toContain(
      "https://tryswipein.com/lm/founder-playbook",
    );
    expect(result.dmTemplate).not.toContain("{{resource");
  });

  test("a DM without the resource token is allowed", () => {
    // The token used to be mandatory, which blocked a real workflow: giving
    // away something that does not live in SwipeIn (a Notion doc, a Calendly,
    // a file on your own site) by pasting that link into the DM yourself.
    const defaults = defaultLeadSharkAutomationDefaults();
    expect(validateLeadSharkAutomationDefaults(defaults)).toEqual([]);

    expect(
      validateLeadSharkAutomationDefaults({
        ...defaults,
        dmTemplate: "Hey {{firstName}} — grab it here: https://my.site/guide",
        dmTemplateVariations: ["Hey {{firstName}}, here you go."],
      }),
    ).toEqual([]);
  });

  test("the token still substitutes when it IS used", () => {
    // Making it optional must not stop it working for the common case.
    const defaults = defaultLeadSharkAutomationDefaults();
    const result = materializeLeadSharkAutomationDefaults(defaults, {
      name: "Founder playbook",
      url: "https://tryswipein.com/lm/founder-playbook",
      keyword: "PLAYBOOK",
    });
    expect(result.dmTemplate).toContain(
      "https://tryswipein.com/lm/founder-playbook",
    );
    expect(result.dmTemplate).not.toContain("{{resource");
  });

  test("other content rules still apply", () => {
    // Only the token requirement was dropped; a DM that is empty or otherwise
    // invalid must still be rejected, or the save path has no guard at all.
    const defaults = defaultLeadSharkAutomationDefaults();
    expect(
      validateLeadSharkAutomationDefaults({ ...defaults, dmTemplate: "" }),
    ).not.toEqual([]);
  });
});
