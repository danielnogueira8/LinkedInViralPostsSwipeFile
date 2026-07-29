import {
  validateAutomationConfig,
  type AutomationConfigDraft,
  type ValidationIssue,
} from "@/lib/leadshark-config";

export const RESOURCE_NAME_TOKEN = "{{resourceName}}";
export const RESOURCE_URL_TOKEN = "{{resourceUrl}}";

export type LeadSharkAutomationDefaults = AutomationConfigDraft;

export function defaultLeadSharkAutomationDefaults(): LeadSharkAutomationDefaults {
  return {
    keywords: [],
    dmTemplate: `Hey {{firstName}}! Here's the ${RESOURCE_NAME_TOKEN}: ${RESOURCE_URL_TOKEN}`,
    dmTemplateVariations: [],
    commentReplyTemplates: [
      "{{firstNameMention}} just sent it — check your DMs!",
    ],
    nonConnectionReplyTemplates: [
      "{{firstNameMention}}, connect with me and I'll send it over.",
    ],
    autoConnect: false,
    autoLike: false,
    followUpEnabled: false,
    followUpTemplate: null,
    followUpDelayMinutes: 60,
    followUpOnlyIfNoResponse: true,
  };
}

function replaceResourceTokens(
  value: string | null,
  resource: { name: string; url: string },
): string | null {
  if (value === null) return null;
  return value
    .replaceAll(RESOURCE_NAME_TOKEN, resource.name)
    .replaceAll(RESOURCE_URL_TOKEN, resource.url);
}

export function materializeLeadSharkAutomationDefaults(
  defaults: LeadSharkAutomationDefaults,
  resource: { name: string; url: string },
): AutomationConfigDraft {
  return {
    ...defaults,
    dmTemplate: replaceResourceTokens(defaults.dmTemplate, resource) ?? "",
    dmTemplateVariations: defaults.dmTemplateVariations.map(
      (value) => replaceResourceTokens(value, resource) ?? "",
    ),
    commentReplyTemplates: defaults.commentReplyTemplates.map(
      (value) => replaceResourceTokens(value, resource) ?? "",
    ),
    nonConnectionReplyTemplates: defaults.nonConnectionReplyTemplates.map(
      (value) => replaceResourceTokens(value, resource) ?? "",
    ),
    followUpTemplate: replaceResourceTokens(
      defaults.followUpTemplate,
      resource,
    ),
  };
}

export function validateLeadSharkAutomationDefaults(
  defaults: LeadSharkAutomationDefaults,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!defaults.dmTemplate.includes(RESOURCE_URL_TOKEN)) {
    issues.push({
      field: "dmTemplate",
      message: `The default DM must include ${RESOURCE_URL_TOKEN}.`,
    });
  }
  if (
    defaults.dmTemplateVariations.some(
      (template) => !template.includes(RESOURCE_URL_TOKEN),
    )
  ) {
    issues.push({
      field: "dmTemplateVariations",
      message: `Every DM variation must include ${RESOURCE_URL_TOKEN}.`,
    });
  }
  const materialized = materializeLeadSharkAutomationDefaults(defaults, {
    // Validate against deliberately long replacements so a saved template
    // cannot become invalid only when a real resource is inserted later.
    name: "R".repeat(240),
    url: `https://tryswipein.com/lm/${"s".repeat(400)}`,
  });
  return [...issues, ...validateAutomationConfig(materialized)];
}
