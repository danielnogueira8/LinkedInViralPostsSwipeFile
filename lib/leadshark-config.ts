// Shared, pure validation + prefill rules for a LeadShark automation config.
// Used by the API route (authoritative) and referenced by the editor panel so
// client and server agree on the same constraints (build plan §5.4).

import { DM_TEMPLATE_MAX_CHARS, MAX_KEYWORDS } from "@/lib/leadshark";

// The ONLY template variables we offer. LeadShark's dashboard shows more
// ({{lastName}}, a full-name-mention chip) but they're not in the API reference,
// so an unsubstituted one could reach a real prospect — we don't allow them
// until a probe confirms.
export const ALLOWED_TEMPLATE_VARS = [
  "firstName",
  "fullName",
  "linkedinUsername",
  "firstNameMention",
] as const;

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// The follow-up delay presets the dropdown offers (minutes). A numeric override
// is also allowed by the validator (any positive integer).
export const FOLLOW_UP_DELAY_PRESETS = [15, 60, 240, 1440, 4320] as const;

export type AutomationConfigDraft = {
  keywords: string[];
  dmTemplate: string;
  dmTemplateVariations: string[];
  commentReplyTemplates: string[];
  nonConnectionReplyTemplates: string[];
  autoConnect: boolean;
  autoLike: boolean;
  followUpEnabled: boolean;
  followUpTemplate: string | null;
  followUpDelayMinutes: number;
  followUpOnlyIfNoResponse: boolean;
};

export type ValidationIssue = { field: string; message: string };

// Return every unknown {{variable}} used across the given templates.
export function unknownTemplateVars(templates: Array<string | null | undefined>): string[] {
  const allowed = new Set<string>(ALLOWED_TEMPLATE_VARS);
  const unknown = new Set<string>();
  for (const t of templates) {
    if (!t) continue;
    for (const m of t.matchAll(TEMPLATE_VAR_RE)) {
      const name = m[1];
      if (!allowed.has(name)) unknown.add(name);
    }
  }
  return [...unknown];
}

// True if a template contains any URL — the DM should deliver a link (soft warn).
export function containsUrl(text: string): boolean {
  return /https?:\/\/\S+/i.test(text) || /\{\{\s*url\s*\}\}/i.test(text);
}

// Authoritative validation. Returns [] when valid. Keyword-blank is VALID
// (means "every comment"); follow-up template is required only when enabled.
export function validateAutomationConfig(cfg: AutomationConfigDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const dm = cfg.dmTemplate?.trim() ?? "";
  if (!dm) {
    issues.push({ field: "dmTemplate", message: "Enter the DM to send." });
  } else if (dm.length > DM_TEMPLATE_MAX_CHARS) {
    issues.push({
      field: "dmTemplate",
      message: `The DM must be ${DM_TEMPLATE_MAX_CHARS} characters or fewer.`,
    });
  }

  if (cfg.keywords.length > MAX_KEYWORDS) {
    issues.push({ field: "keywords", message: `Use at most ${MAX_KEYWORDS} keywords.` });
  }

  for (const v of cfg.dmTemplateVariations) {
    if (v.trim().length > DM_TEMPLATE_MAX_CHARS) {
      issues.push({
        field: "dmTemplateVariations",
        message: `Each DM variation must be ${DM_TEMPLATE_MAX_CHARS} characters or fewer.`,
      });
      break;
    }
  }

  if (cfg.followUpEnabled) {
    if (!cfg.followUpTemplate?.trim()) {
      issues.push({
        field: "followUpTemplate",
        message: "Enter the follow-up message, or turn follow-up off.",
      });
    }
    if (!Number.isInteger(cfg.followUpDelayMinutes) || cfg.followUpDelayMinutes <= 0) {
      issues.push({
        field: "followUpDelayMinutes",
        message: "Choose a valid follow-up delay.",
      });
    }
  }

  const unknown = unknownTemplateVars([
    cfg.dmTemplate,
    ...cfg.dmTemplateVariations,
    ...cfg.commentReplyTemplates,
    ...cfg.nonConnectionReplyTemplates,
    cfg.followUpTemplate,
  ]);
  if (unknown.length) {
    issues.push({
      field: "template",
      message: `Unsupported variables: ${unknown
        .map((v) => `{{${v}}}`)
        .join(", ")}. Use only ${ALLOWED_TEMPLATE_VARS.map((v) => `{{${v}}}`).join(", ")}.`,
    });
  }

  return issues;
}

// The default DM body for a lead-magnet draft, per §5.4 prefills.
export function defaultDmTemplate(title: string, url: string): string {
  return `Hey {{firstName}}! Here's the ${title}: ${url}`;
}
