import { normalizeCollapsedMarkdownTables } from "@/lib/markdown-tables";

export type LeadMagnetCreatorContext = {
  displayName?: string | null;
  avatarUrl?: string | null;
  headline?: string | null;
  summary?: string | null;
};

export type LeadMagnetCtaContext = {
  url?: string | null;
  label?: string | null;
};

export function firstNameFromDisplayName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

export function renderLeadMagnetCreatorContext(
  creator: LeadMagnetCreatorContext | null | undefined,
): string {
  const lines = [
    creator?.displayName ? `Creator name: ${creator.displayName.trim()}` : null,
    firstNameFromDisplayName(creator?.displayName)
      ? `Creator first name: ${firstNameFromDisplayName(creator?.displayName)}`
      : null,
    creator?.headline ? `Verified LinkedIn headline: ${creator.headline.trim()}` : null,
    creator?.summary ? `Voice/profile summary: ${creator.summary.trim()}` : null,
    creator?.avatarUrl
      ? `Creator image markdown to place after the hook and before the intro: ![${creator.displayName?.trim() || "Creator"}](${creator.avatarUrl.trim()})`
      : "Creator image markdown: Not available; do not invent an image.",
  ].filter(Boolean);

  if (lines.length === 0) {
    return "Creator context: Not available. Keep the intro useful but do not invent credentials, company names, years of experience, client counts, or personal facts.";
  }

  return [
    "Creator context for the personal intro:",
    ...lines,
    "Use only these verified facts. Do not invent credentials, company names, years of experience, client counts, or personal facts.",
  ].join("\n");
}

export function renderLeadMagnetStructureRequirements(
  cta: LeadMagnetCtaContext | null | undefined,
): string {
  const ctaLabel = cta?.label?.trim() || "Book a 30-min call";
  const ctaUrl = cta?.url?.trim();
  return [
    "Full-guide structure:",
    "- Do not include a markdown H1 or repeat the resource title. The public page renders the title separately.",
    "- Start with a one-sentence hook that names the result the reader will get.",
    "- If creator image markdown is available, place it immediately after the hook and before the intro.",
    "- Then write a personal intro in this shape:",
    "  Hey, I'm {first name}. {Use the verified headline/profile summary in one plain sentence}.",
    "  I built this {resource type} so you can {specific job-to-be-done}.",
    "  What you'll get out of it: {specific outcome and practical next step}.",
    "- Add a short `## How to use this resource` section with 2-3 bullets: who it is for, what to prepare, and the fastest useful path through it.",
    ctaUrl
      ? [
          "- End the guide with this optional DIY-skip blockquote exactly once, immediately after the quick implementation plan:",
          "  > **Prefer to skip the DIY?**",
          "  >",
          "  > If you want help applying this to your content, grab a slot on my calendar.",
          "  >",
          `  > [${ctaLabel} → ${ctaUrl}](${ctaUrl})`,
        ].join("\n")
      : "- Do not include a calendar/book-a-call CTA block unless a CTA link is provided.",
    "- Continue with a practical step-by-step guide. Each section must help the reader complete part of the promised outcome.",
    "- Include at least one copy-ready tool, template, checklist, script, prompt, scorecard, or decision rule that the reader can use without rewriting the guide.",
    "- Include a clearly labeled worked example or before-and-after demonstration. Keep it illustrative and never invent client facts, proof, or metrics.",
    "- End with `## Quick implementation plan` followed by exactly three numbered actions: what to do first, what to do next, and how to review the result.",
    "- If a CTA link is provided, the DIY-skip block above is the only CTA.",
  ].join("\n");
}

export type LeadMagnetQualityAssessment = {
  passed: boolean;
  issues: string[];
};

export function assessGeneratedLeadMagnetMarkdown(
  markdown: string,
): LeadMagnetQualityAssessment {
  const issues: string[] = [];
  const normalized = markdown.trim();
  if (normalized.length < 900) {
    issues.push("The guide is too short to be genuinely useful.");
  }
  if (/\[(?:add|insert|replace)\s+(?:an?\s+)?(?:examples?|details?|content|copy|text|image|link)\s*(?:here)?\]|\b(?:todo|tbd)\b/iu.test(normalized)) {
    issues.push("The guide contains unfinished placeholder text.");
  }
  if (/^#{1,3}\s+(?:conclusion|final thoughts|wrapping up)\s*$/imu.test(normalized)) {
    issues.push("Replace the generic conclusion with a quick implementation plan.");
  }
  if (!/^#{2,3}\s+quick implementation plan\s*$/imu.test(normalized)) {
    issues.push("The guide is missing a quick implementation plan.");
  }
  if (!/^#{2,3}\s+(?:how to use(?: this resource)?|start here|before you start)\s*$/imu.test(normalized)) {
    issues.push("The guide is missing a short 'How to use this resource' section.");
  }
  const hasUsableAsset =
    /^#{2,3}\s+.*\b(?:checklist|template|script|prompt|scorecard|worksheet|swipe file|decision rules?|toolkit)\b.*$/imu.test(normalized) ||
    /^\s*[-*]\s+\[[ xX]\]\s+\S/gmu.test(normalized) ||
    /^```/mu.test(normalized) ||
    /^\|.+\|\s*$/mu.test(normalized);
  if (!hasUsableAsset) {
    issues.push("The guide needs at least one copy-ready tool, template, checklist, script, prompt, scorecard, or decision rule.");
  }
  if (!/^#{2,3}\s+.*\b(?:worked example|example|before\s*(?:and|&)\s*after|in practice|walkthrough)\b.*$/imu.test(normalized)) {
    issues.push("The guide needs a concrete worked example or before-and-after demonstration.");
  }
  const quickPlanHeading = /^#{2,3}\s+quick implementation plan\s*$/imu.exec(normalized);
  const quickPlanBody = quickPlanHeading
    ? normalized
        .slice(quickPlanHeading.index + quickPlanHeading[0].length)
        .split(/^#{1,3}\s+/mu, 1)[0]
    : "";
  const quickPlanActions = quickPlanBody.match(/^\s*\d+[.)]\s+\S/gmu) ?? [];
  if (quickPlanHeading && quickPlanActions.length !== 3) {
    issues.push("The quick implementation plan must contain exactly three numbered actions.");
  }
  const headings = normalized.match(/^#{2,3}\s+.+$/gmu) ?? [];
  if (headings.length < 3) {
    issues.push("The guide needs at least three practical sections.");
  }
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((paragraph) => paragraph.length >= 30 && !paragraph.startsWith("#"));
  if (new Set(paragraphs).size < paragraphs.length) {
    issues.push("The guide repeats the same paragraph.");
  }
  const codeFenceCount = normalized.match(/^```/gmu)?.length ?? 0;
  if (codeFenceCount % 2 !== 0) {
    issues.push("The guide contains an unclosed markdown code block.");
  }
  const finalLine = normalized.split("\n").findLast((line) => line.trim())?.trim() ?? "";
  if (/^(?:#{1,6}\s+.*|.*:)$/u.test(finalLine)) {
    issues.push("The guide ends abruptly.");
  }
  return { passed: issues.length === 0, issues };
}

function normalizedTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function prepareGeneratedLeadMagnetMarkdown(opts: {
  title: string;
  markdown: string;
}): string {
  return stripRepeatedLeadMagnetTitle({
    title: opts.title,
    markdown: sanitizeGeneratedLeadMagnetMarkdown(opts.markdown),
  });
}

export function leadMagnetDisplayMarkdown(opts: {
  title: string;
  markdown: string;
}): string {
  return stripRepeatedLeadMagnetTitle({
    title: opts.title,
    markdown: normalizeCollapsedMarkdownTables(opts.markdown).trim(),
  });
}

function stripRepeatedLeadMagnetTitle(opts: {
  title: string;
  markdown: string;
}): string {
  const lines = opts.markdown.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex >= 0) {
    const heading = lines[firstContentIndex].match(/^#{1,3}\s+(.+)$/);
    if (heading && titlesDescribeSameResource(heading[1], opts.title)) {
      lines.splice(firstContentIndex, 1);
      while (lines[firstContentIndex]?.trim() === "") lines.splice(firstContentIndex, 1);
    }
  }
  return lines.join("\n").trim();
}

export function renderLeadMagnetQualityRequirements(): string {
  return [
    "Lead magnet quality bar:",
    "- Default to a polished Notion-style resource, but choose the right structure for the job: prompt pack, checklist, swipe file, scorecard, script library, teardown, or framework.",
    "- Make it dense and useful. Every section should help the reader do a specific task, make a decision, or copy a usable asset.",
    "- Every major section should feel like instructions, not a lecture: tell the reader what to do, give them the usable asset, and show what good looks like.",
    "- Prefer concrete tools: copy/paste prompts, checklists, scoring rubrics, templates, scripts, decision rules, before/after rewrites, and examples when they are genuinely useful.",
    "- Include examples only when they make the resource clearer or when the user supplied enough context. Do not invent client stories, metrics, names, screenshots, or proof.",
    "- Avoid long complete-guide filler. Expert and concise beats broad and generic.",
    "- Ban AI tells: no em dashes, no 'unlock', no 'game-changer', no 'in today's fast-paced world', no 'delve', no 'leverage' as a generic verb, no fake acronym frameworks.",
    "- Use simple punctuation. Use commas, colons, periods, or short parentheses instead of em dashes.",
  ].join("\n");
}

function titlesDescribeSameResource(a: string, b: string): boolean {
  const normalizedA = normalizedTitle(a);
  const normalizedB = normalizedTitle(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  if (
    Math.min(normalizedA.length, normalizedB.length) >= 18 &&
    (normalizedA.startsWith(normalizedB) || normalizedB.startsWith(normalizedA))
  ) {
    return true;
  }
  const aTokens = new Set(normalizedA.split(" ").filter((token) => token.length > 2));
  const bTokens = new Set(normalizedB.split(" ").filter((token) => token.length > 2));
  if (Math.min(aTokens.size, bTokens.size) < 4) return false;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(aTokens.size, bTokens.size) >= 0.7;
}

export function sanitizeGeneratedLeadMagnetMarkdown(markdown: string): string {
  return normalizeCollapsedMarkdownTables(
    markdown
      .replace(/\s*—\s*/g, " - ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n"),
  ).trim();
}

export function splitLeadMagnetCreatorImage(
  markdown: string,
  creator: LeadMagnetCreatorContext | null | undefined,
): { before: string; after: string; imageFound: boolean; image: { alt: string; src: string } | null } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const creatorName = creator?.displayName?.trim().toLowerCase();
  const creatorAvatarUrl = creator?.avatarUrl?.trim();
  const searchLimit = Math.min(lines.length, 18);
  for (let index = 0; index < searchLimit; index += 1) {
    const match = lines[index].trim().match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
    if (!match) continue;
    const alt = match[1].trim().toLowerCase();
    const src = match[2].trim();
    const isCreatorImage =
      (creatorName && alt === creatorName) ||
      (creatorAvatarUrl && src === creatorAvatarUrl) ||
      /profile-displayphoto/i.test(src);
    if (!isCreatorImage) continue;
    return {
      before: lines.slice(0, index).join("\n").trim(),
      after: lines.slice(index + 1).join("\n").trim(),
      imageFound: true,
      image: { alt: match[1].trim(), src },
    };
  }
  return { before: markdown.trim(), after: "", imageFound: false, image: null };
}
