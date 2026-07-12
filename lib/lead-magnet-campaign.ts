import {
  leadMagnetPromptContext,
  type LeadMagnet,
  type LeadMagnetMetadata,
} from "@/lib/lead-magnets";
import { wrapUntrustedDelimited } from "@/lib/agent/untrusted";

type CampaignResource = Pick<
  LeadMagnet,
  "id" | "title" | "markdown_body" | "metadata" | "public_slug"
>;

export type LeadMagnetCampaign = {
  resource: CampaignResource;
  cta: {
    keyword: string;
    instruction: string;
  };
  promptBlock: string;
};

const CTA_STOP_WORDS = new Set([
  "THE",
  "WITH",
  "FROM",
  "THAT",
  "THIS",
  "YOUR",
  "BEST",
  "WAYS",
  "PROMPTS",
  "CREATE",
  "FREE",
  "RESOURCE",
  "GUIDE",
  "PLAYBOOK",
  "CHECKLIST",
  "TEMPLATE",
  "TOOLKIT",
  "LINKEDIN",
]);

export function leadMagnetCtaKeyword(title: string): string {
  const words = title.toUpperCase().match(/\b[A-Z][A-Z0-9]{2,14}\b/g) ?? [];
  return words.find((word) => !CTA_STOP_WORDS.has(word)) ?? "GUIDE";
}

export function buildLeadMagnetCampaign(resource: CampaignResource): LeadMagnetCampaign {
  const keyword = leadMagnetCtaKeyword(resource.title);
  const instruction = `Comment "${keyword}" and I will send it.`;
  const promptBlock = [
    "LEAD MAGNET CAMPAIGN — LOCKED BEFORE DRAFTING",
    "The selected resource below is the only giveaway this post may promote. Model the attached source post's structure and persuasion mechanics, but adapt every substantive claim, promise, bullet, and example to this resource.",
    "Do not substitute a different resource. Do not invent modules, files, worksheets, bonuses, proof, or outcomes unsupported by the selected resource.",
    `Use this exact CTA keyword everywhere: ${keyword}. End with a natural CTA whose instruction is exactly: ${instruction}`,
    wrapUntrustedDelimited({
      label: "SELECTED LEAD MAGNET",
      endLabel: "END LEAD MAGNET",
      text: leadMagnetPromptContext(resource),
    }),
  ].join("\n\n");

  return {
    resource,
    cta: { keyword, instruction },
    promptBlock,
  };
}

export function leadMagnetSelectionPromptBeforeDraft(opts: {
  userText: string;
  sourceText?: string | null;
}): string {
  return [
    "Choose the saved lead magnet resource that should be promoted before writing the post.",
    `User request: ${opts.userText}`,
    opts.sourceText?.trim()
      ? `Source post whose structure will be modeled:\n${opts.sourceText.trim().slice(0, 4000)}`
      : "No source post text was attached. Choose from the user's stated topic and intent.",
  ]
    .join("\n\n")
    .slice(0, 6000);
}

export function enforceLeadMagnetCampaignCta(
  body: string,
  campaign: LeadMagnetCampaign,
): string {
  const canonicalComment = `Comment "${campaign.cta.keyword}"`;
  const commentKeywordPattern =
    /\bcomment\s+(?:["“”']\s*)?[A-Z][A-Z0-9_-]{2,24}(?:\s*["“”'])?/gi;
  if (commentKeywordPattern.test(body)) {
    return body.replace(commentKeywordPattern, canonicalComment).trim();
  }
  return `${body.trim()}\n\n${campaign.cta.instruction}`;
}

export function hasLeadMagnetResourceOverlap(
  body: string,
  campaign: LeadMagnetCampaign,
): boolean {
  const sourceText = [
    campaign.resource.title,
    campaign.resource.metadata.summary ?? "",
    campaign.resource.metadata.selection_summary ?? "",
    ...(campaign.resource.metadata.deliverables ?? []),
    campaign.resource.markdown_body.slice(0, 4000),
  ].join(" ");
  const terms = Array.from(
    new Set(
      (sourceText.toLowerCase().match(/\b[a-z0-9]{4,}\b/g) ?? []).filter(
        (term) =>
          !CTA_STOP_WORDS.has(term.toUpperCase()) &&
          term.toUpperCase() !== campaign.cta.keyword,
      ),
    ),
  );
  if (terms.length === 0) return false;
  const normalizedBody = body.toLowerCase();
  return terms.some((term) => normalizedBody.includes(term));
}

export function campaignImageContext(campaign: LeadMagnetCampaign): {
  id: string;
  title: string;
  metadata: LeadMagnetMetadata;
  ctaKeyword: string;
} {
  return {
    id: campaign.resource.id,
    title: campaign.resource.title,
    metadata: campaign.resource.metadata,
    ctaKeyword: campaign.cta.keyword,
  };
}
