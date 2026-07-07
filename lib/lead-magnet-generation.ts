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
    "Lead magnet opening structure:",
    "- Start with a clear title and a one-sentence hook that names the result the reader will get.",
    "- If creator image markdown is available, place it immediately after the hook and before the intro.",
    "- Then write a personal intro in this shape:",
    "  Hey, I'm {first name}. {Use the verified headline/profile summary in one plain sentence}.",
    "  I built this {resource type} so you can {specific job-to-be-done}.",
    "  What you'll get out of it: {specific outcome and practical next step}.",
    ctaUrl
      ? [
          "- Then include this optional DIY-skip blockquote exactly once, before the practical sections:",
          "  > **Prefer to skip the DIY?**",
          "  >",
          "  > If you want help applying this to your content, grab a slot on my calendar.",
          "  >",
          `  > [${ctaLabel} → ${ctaUrl}](${ctaUrl})`,
        ].join("\n")
      : "- Do not include a calendar/book-a-call CTA block unless a CTA link is provided.",
    "- After that, continue with practical Notion-like sections: headings, checklists, prompts, examples, scripts, scorecards, or templates.",
  ].join("\n");
}

export function renderLeadMagnetQualityRequirements(): string {
  return [
    "Lead magnet quality bar:",
    "- Default to a polished Notion-style resource, but choose the right structure for the job: prompt pack, checklist, swipe file, scorecard, script library, teardown, or framework.",
    "- Make it dense and useful. Every section should help the reader do a specific task, make a decision, or copy a usable asset.",
    "- Prefer concrete tools: copy/paste prompts, checklists, scoring rubrics, templates, scripts, decision rules, before/after rewrites, and examples when they are genuinely useful.",
    "- Include examples only when they make the resource clearer or when the user supplied enough context. Do not invent client stories, metrics, names, screenshots, or proof.",
    "- Avoid long complete-guide filler. Expert and concise beats broad and generic.",
    "- Ban AI tells: no em dashes, no 'unlock', no 'game-changer', no 'in today's fast-paced world', no 'delve', no 'leverage' as a generic verb, no fake acronym frameworks.",
    "- Use simple punctuation. Use commas, colons, periods, or short parentheses instead of em dashes.",
  ].join("\n");
}

export function sanitizeGeneratedLeadMagnetMarkdown(markdown: string): string {
  return markdown
    .replace(/\s*—\s*/g, " - ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function splitLeadMagnetCreatorImage(
  markdown: string,
  creator: LeadMagnetCreatorContext | null | undefined,
): { before: string; after: string; imageFound: boolean } {
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
    };
  }
  return { before: markdown.trim(), after: "", imageFound: false };
}
