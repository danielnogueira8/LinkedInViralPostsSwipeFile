import {
  defaultDmTemplate,
  type AutomationConfigDraft,
} from "./leadshark-config";
import {
  materializeLeadSharkAutomationDefaults,
  type LeadSharkAutomationDefaults,
} from "./leadshark-default-config";
import { inferCommentKeyword } from "./lead-magnet-image-generation";

// ---------------------------------------------------------------------------
// The starting config for a lead-magnet post's comment-to-DM automation.
//
// Shared by TWO callers, and that is the whole point:
//   • GET /api/drafts/[id]/automation — a post that exists
//   • POST /api/drafts/automation-prefill — a post still being written
//
// It lived only in the first one, so the editor showed a workspace's saved
// defaults on a saved post and an EMPTY form on a new one. Same screen, same
// user, different answer depending on whether a row happened to exist yet —
// which reads as "my settings didn't save".
//
// Pure: the caller fetches the workspace defaults and resolves the giveaway,
// so the decision itself is testable without a database.
// ---------------------------------------------------------------------------

export type PrefillLeadMagnet = {
  id?: string | null;
  title?: string | null;
  publicSlug?: string | null;
};

export type AutomationPrefill = {
  keyword: string;
  dmTemplate: string;
  leadMagnetId: string | null;
  leadMagnetTitle: string | null;
  leadMagnetUrl: string | null;
  config: AutomationConfigDraft;
};

export function buildAutomationPrefill(args: {
  /** The attached giveaway, or null — a lead-magnet post can promise a link
   *  that was never stored as a resource. */
  leadMagnet: PrefillLeadMagnet | null;
  /** Post body, used to infer the comment keyword. */
  body: string;
  /** Origin for the public resource URL, e.g. https://app.example.com */
  origin: string;
  /** The workspace's saved defaults, or null when none are stored yet. */
  savedDefaults: LeadSharkAutomationDefaults | null;
}): AutomationPrefill {
  const lm = args.leadMagnet;
  const title = lm?.title?.trim() || "resource";
  const slug = lm?.publicSlug ?? null;
  const url = slug ? `${args.origin}/lm/${slug}` : "";
  const keyword = inferCommentKeyword(args.body ?? "", lm?.title ?? "");

  const config: AutomationConfigDraft = args.savedDefaults
    ? materializeLeadSharkAutomationDefaults(args.savedDefaults, {
        name: title,
        url: url || "your link",
        keyword,
      })
    : {
        keywords: [keyword].filter(Boolean),
        dmTemplate: defaultDmTemplate(title, url || "your link"),
        dmTemplateVariations: [],
        commentReplyTemplates: [],
        nonConnectionReplyTemplates: [],
        autoConnect: false,
        autoLike: false,
        followUpEnabled: false,
        followUpTemplate: null,
        followUpDelayMinutes: 60,
        followUpOnlyIfNoResponse: true,
      };

  return {
    keyword: config.keywords[0] ?? "",
    dmTemplate: config.dmTemplate,
    leadMagnetId: lm?.id ?? null,
    leadMagnetTitle: lm?.title ?? null,
    leadMagnetUrl: url || null,
    config,
  };
}
