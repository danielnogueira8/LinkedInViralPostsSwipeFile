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

export type LeadMagnetCampaignDraftTransform =
  | { ok: true; body: string }
  | { ok: false; message: string };

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

const REQUEST_TOPIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "content",
  "best",
  "favorite",
  "favourite",
  "first",
  "for",
  "ideas",
  "last",
  "lead",
  "magnet",
  "my",
  "of",
  "on",
  "post",
  "the",
  "tips",
  "to",
  "top",
  "use",
  "ways",
  "with",
]);

const RESOURCE_OVERLAP_STOP_WORDS = new Set([
  "A",
  "AN",
  "ABOUT",
  "BETTER",
  "CONTENT",
  "CREATE",
  "FREE",
  "HELPS",
  "IMPROVE",
  "IMPROVING",
  "LINKEDIN",
  "OF",
  "THE",
  "TO",
  "YOUR",
  "PRACTICAL",
  "SIMPLE",
  "USE",
  "USING",
]);

const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

const VERSION_CONNECTORS = new Set(["model", "version"]);
const VERSION_TOPIC_CONTINUATIONS = new Set([
  "about",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "to",
  "with",
]);
const GENERIC_COUNT_PREFIXES = new Set([
  "after",
  "all",
  "before",
  "best",
  "during",
  "favorite",
  "favourite",
  "first",
  "from",
  "key",
  "last",
  "many",
  "most",
  "next",
  "our",
  "over",
  "remaining",
  "several",
  "some",
  "their",
  "these",
  "those",
  "top",
  "your",
]);

function comparableTokens(text: string): string[] {
  return (
    text.toLowerCase().match(/[\p{L}]+|\d+(?:\.\d+)*/gu) ?? []
  ).map(
    (token) => NUMBER_WORDS[token] ?? token,
  );
}

function explicitRequestTopic(userInstruction: string): {
  label: string;
  anchors: string[];
} | null {
  const match = userInstruction.match(
    /\b(?:about|regarding|focused on|on the topic of)\s+([^!?\n]+)/i,
  );
  if (!match?.[1]) return null;
  const label = match[1]
    .split(/\b(?:using|while|but|in my voice|and (?:use|keep|make))\b/i)[0]
    .trim();
  if (
    /^(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:ideas|tips|ways)\b/i.test(
      label,
    )
  ) {
    return null;
  }
  const tokens = comparableTokens(label);
  const numericIndex = tokens.findIndex((token) =>
    /^\d+(?:\.\d+)*$/.test(token),
  );
  if (numericIndex < 0) return null;
  const rawTokens =
    label.match(/[\p{L}]+|\d+(?:\.\d+)*/gu) ?? [];
  const previousToken = tokens[numericIndex - 1];
  if (GENERIC_COUNT_PREFIXES.has(previousToken)) return null;
  const candidateIndex = VERSION_CONNECTORS.has(previousToken)
    ? numericIndex - 2
    : numericIndex - 1;
  const candidate = tokens[candidateIndex];
  const candidateLooksNamed = /^\p{Lu}/u.test(rawTokens[candidateIndex] ?? "");
  const followingToken = tokens[numericIndex + 1];
  if (
    followingToken &&
    !VERSION_TOPIC_CONTINUATIONS.has(followingToken) &&
    !candidateLooksNamed &&
    !VERSION_CONNECTORS.has(previousToken)
  ) {
    return null;
  }
  const entityAnchor =
    candidate &&
    candidate.length >= 3 &&
    !REQUEST_TOPIC_STOP_WORDS.has(candidate) &&
    !/^\d+(?:\.\d+)*$/.test(candidate)
      ? candidate
      : null;
  // Only enforce high-confidence named/versioned topics ("Opus 5"). Generic
  // semantic fidelity stays with the writer rather than risking false rejects.
  // A bare count ("about 5 ways...") is not a safe topic anchor.
  if (!entityAnchor) return null;
  return {
    label,
    anchors: [entityAnchor, tokens[numericIndex]],
  };
}

export function hasLeadMagnetRequestTopicOverlap(
  body: string,
  userInstruction: string,
): boolean {
  const topic = explicitRequestTopic(userInstruction);
  if (!topic) return true;
  const bodyTokens = new Set(comparableTokens(body));
  return topic.anchors.every((anchor) => bodyTokens.has(anchor));
}

export function leadMagnetCtaKeyword(title: string): string {
  const words = title.toUpperCase().match(/\b[A-Z][A-Z0-9]{2,14}\b/g) ?? [];
  return words.find((word) => !CTA_STOP_WORDS.has(word)) ?? "GUIDE";
}

export function buildLeadMagnetCampaign(resource: CampaignResource): LeadMagnetCampaign {
  const keyword = leadMagnetCtaKeyword(resource.title);
  const instruction = `Comment "${keyword}" and I will send it.`;
  const promptBlock = [
    "LEAD MAGNET CAMPAIGN — LOCKED BEFORE DRAFTING",
    "The CURRENT REQUEST owns the post topic, thesis, and angle. If the request names a product, model, version, person, event, or other subject, the post must explicitly discuss it and build its core narrative around it. Never replace that subject with the selected resource.",
    "The selected resource owns only the giveaway details and CTA. It is the only giveaway this post may promote. Connect it honestly to the requested topic instead of turning it into the topic unless the CURRENT REQUEST explicitly asks for that.",
    "Model any attached source post's structure and persuasion mechanics, but adapt its substantive claims and examples to the CURRENT REQUEST. Claims, promises, bullets, and examples about the giveaway itself must stay faithful to the selected resource.",
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

export function transformLeadMagnetCampaignDraft(
  body: string,
  campaign: LeadMagnetCampaign,
  userInstruction: string,
): LeadMagnetCampaignDraftTransform {
  const topic = explicitRequestTopic(userInstruction);
  if (topic && !hasLeadMagnetRequestTopicOverlap(body, userInstruction)) {
    return {
      ok: false,
      message: `The draft ignored the requested topic "${topic.label}". Rewrite it so that topic is explicit while keeping the selected giveaway and CTA.`,
    };
  }
  if (!hasLeadMagnetResourceOverlap(body, campaign)) {
    return {
      ok: false,
      message: `The draft omitted the selected giveaway "${campaign.resource.title}". Rewrite it so the post promotes that exact resource without changing the requested topic.`,
    };
  }
  return {
    ok: true,
    body: enforceLeadMagnetCampaignCta(body, campaign),
  };
}

export function hasLeadMagnetResourceOverlap(
  body: string,
  campaign: LeadMagnetCampaign,
): boolean {
  const normalizedBody = body.toLowerCase();
  const normalizedTitle = campaign.resource.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (normalizedTitle && normalizedBody.includes(normalizedTitle)) return true;

  const titleTerms = Array.from(
    new Set(
      comparableTokens(campaign.resource.title).filter(
        (term) =>
          term.length >= 4 &&
          !/^\d+(?:\.\d+)*$/.test(term) &&
          !RESOURCE_OVERLAP_STOP_WORDS.has(term.toUpperCase()),
      ),
    ),
  );
  if (titleTerms.length > 0) {
    const requiredTitleTerms = Math.min(2, titleTerms.length);
    const matchedTitleTerms = titleTerms.filter((term) =>
      normalizedBody.includes(term),
    ).length;
    if (matchedTitleTerms >= requiredTitleTerms) return true;
  }

  const sourceText = [
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
          !RESOURCE_OVERLAP_STOP_WORDS.has(term.toUpperCase()) &&
          !Object.prototype.hasOwnProperty.call(NUMBER_WORDS, term) &&
          term.toUpperCase() !== campaign.cta.keyword,
      ),
    ),
  );
  const requiredDetailTerms = Math.min(2, terms.length);
  if (requiredDetailTerms === 0) return false;
  return (
    terms.filter((term) => normalizedBody.includes(term)).length >=
    requiredDetailTerms
  );
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
