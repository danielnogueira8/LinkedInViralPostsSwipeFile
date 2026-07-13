import type { ChatMessage } from "@/lib/openrouter";

const OUTPUT_GROUNDING_PROMPT = `OUTPUT GROUNDING CONTRACT — apply this to the current user turn:
- Follow the requested deliverable, count, and format exactly.
- JUST / ONLY is a hard output boundary. If the user says "just", "only", "no intro", or "no explanation", output only the requested items: no lead-in, no summary, no source note, no commentary, and no next-step question. For "just N hooks", every non-empty line must be one of the N numbered hooks.
- Never invent factual specifics. A number, percentage, currency amount, date, named customer, result, testimonial, or first-person experience must come from the user, conversation, or an actual tool/source result. For a generic topic with no supplied facts, hooks and angles must contain no standalone numbers, percentages, currency amounts, precise performance claims, dates, or first-person pronouns (I / me / my / we / our). Use honest qualitative wording in second or third person instead.`;

export function todayDateMessage(today: Date = new Date()): ChatMessage {
  const iso = today.toISOString().slice(0, 10);
  return {
    role: "system",
    content:
      `Today's date is ${iso} (UTC). Use it ONLY to resolve relative dates the ` +
      `user mentions — e.g. "yesterday", "last week", "this month", "earlier ` +
      `this year". It is NOT the recency of any data you have. When you describe ` +
      `how fresh the tracked posts are, still cite the tool's scrape date ` +
      `(get_top_from_batch's \`scrape.scraped_at\`) and each post's \`posted_at\` — ` +
      `never today's date, and never imply a post is newer than its own \`posted_at\`.\n\n` +
      OUTPUT_GROUNDING_PROMPT,
  };
}
