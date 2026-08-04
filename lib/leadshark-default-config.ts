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
  context: { name: string; url: string; keyword: string },
): AutomationConfigDraft {
  return {
    ...defaults,
    keywords: [context.keyword.trim()].filter(Boolean),
    dmTemplate: replaceResourceTokens(defaults.dmTemplate, context) ?? "",
    dmTemplateVariations: defaults.dmTemplateVariations.map(
      (value) => replaceResourceTokens(value, context) ?? "",
    ),
    commentReplyTemplates: defaults.commentReplyTemplates.map(
      (value) => replaceResourceTokens(value, context) ?? "",
    ),
    nonConnectionReplyTemplates: defaults.nonConnectionReplyTemplates.map(
      (value) => replaceResourceTokens(value, context) ?? "",
    ),
    followUpTemplate: replaceResourceTokens(
      defaults.followUpTemplate,
      context,
    ),
  };
}

export function validateLeadSharkAutomationDefaults(
  defaults: LeadSharkAutomationDefaults,
): ValidationIssue[] {
  // {{resourceUrl}} is a convenience, not a requirement. Users routinely link
  // a resource that does not live in SwipeIn — a Notion page, a Calendly, a
  // file on their own site — by pasting the URL straight into the DM. Forcing
  // the token blocked that entirely, so a perfectly good automation could not
  // be saved. The token still substitutes when present; its absence just means
  // the user supplied the link themselves.
  const issues: ValidationIssue[] = [];
  const materialized = materializeLeadSharkAutomationDefaults(defaults, {
    // Validate against deliberately long replacements so a saved template
    // cannot become invalid only when a real resource is inserted later.
    name: "R".repeat(240),
    url: `https://tryswipein.com/lm/${"s".repeat(400)}`,
    keyword: "GUIDE",
  });
  return [...issues, ...validateAutomationConfig(materialized)];
}
