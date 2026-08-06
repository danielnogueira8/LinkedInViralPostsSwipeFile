// ---------------------------------------------------------------------------
// Turning a stored digest into something readable.
//
// The model returns one markdown blob with four known sections. Rendering that
// blob raw would be a wall of text — the whole value of the digest is that you
// can scan it in ten seconds, and a wall of text is exactly what it was meant
// to replace.
//
// So we PARSE rather than render markdown generically. The structure is known
// (we wrote the prompt), which means we can give each section its own visual
// treatment: the hook as a pull-quote, the angles as cards you act on.
//
// Everything here is pure and defensive. The input is model output, so it will
// eventually drift from the prompt's format — a missing heading must degrade to
// "show the text as-is", never to a blank page.
// ---------------------------------------------------------------------------

export type DigestSectionId = "theme" | "hook" | "format" | "write_next";

export type DigestSection = {
  id: DigestSectionId;
  /** Display heading, ours — not the model's, so casing stays consistent. */
  title: string;
  body: string;
};

export type ParsedDigest = {
  sections: DigestSection[];
  /**
   * Text that matched no section. Non-empty means the model drifted from the
   * format; the UI shows it rather than dropping it, because silently losing
   * model output is how you end up debugging a "blank" digest that was fine.
   */
  unmatched: string;
};

const SECTION_TITLES: Record<DigestSectionId, string> = {
  theme: "Theme",
  hook: "Best hook",
  format: "Format that worked",
  write_next: "Write next",
};

/**
 * Heading matchers, in prompt order.
 *
 * Tolerant on purpose: the model has produced "1. THEME —", "## 2. BEST HOOK",
 * and "**3. FORMAT**" across runs. Anchoring on the KEYWORD rather than the
 * exact decoration keeps parsing working when the model reformats, which it
 * does without warning.
 */
const SECTION_PATTERNS: Array<{ id: DigestSectionId; test: RegExp }> = [
  { id: "theme", test: /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*(?:1[.)]\s*)?THEME\b/i },
  { id: "hook", test: /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*(?:2[.)]\s*)?BEST\s+HOOK\b/i },
  { id: "format", test: /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*(?:3[.)]\s*)?FORMAT\b/i },
  {
    id: "write_next",
    test: /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*(?:4[.)]\s*)?WRITE\s+NEXT\b/i,
  },
];

/** Strip the heading itself, keeping any text that followed it on the line. */
function bodyAfterHeading(line: string): string {
  return line
    .replace(/^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*\d[.)]\s*/, "")
    .replace(/^\s*(?:THEME|BEST\s+HOOK|FORMAT|WRITE\s+NEXT)\b/i, "")
    .replace(/^\s*\*\*/, "")
    .replace(/^[\s—–:-]+/, "")
    .trim();
}

export function parseDigest(content: string): ParsedDigest {
  const lines = (content ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections: DigestSection[] = [];
  const preamble: string[] = [];
  let current: { id: DigestSectionId; lines: string[] } | null = null;

  for (const line of lines) {
    const match = SECTION_PATTERNS.find((pattern) => pattern.test.test(line));
    if (match && !sections.some((s) => s.id === match.id)) {
      if (current) {
        sections.push({
          id: current.id,
          title: SECTION_TITLES[current.id],
          body: current.lines.join("\n").trim(),
        });
      }
      const rest = bodyAfterHeading(line);
      current = { id: match.id, lines: rest ? [rest] : [] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) {
    sections.push({
      id: current.id,
      title: SECTION_TITLES[current.id],
      body: current.lines.join("\n").trim(),
    });
  }

  return {
    sections: sections.filter((section) => section.body.length > 0),
    unmatched: preamble.join("\n").trim(),
  };
}

/**
 * Pull the quoted hook out of the BEST HOOK section for pull-quote display.
 *
 * Returns null when no quoted string is found rather than guessing at a
 * substring — a mis-extracted "hook" presented in large type is worse than
 * showing the section as ordinary prose.
 */
export function extractHookQuote(body: string): string | null {
  const match =
    body.match(/[""]([^""]{4,300})[""]/) ?? body.match(/"([^"]{4,300})"/);
  return match ? match[1].trim() : null;
}

/**
 * The commentary that surrounds the quote, with the quote itself removed.
 *
 * Split out rather than done inline at the call site because the leftovers are
 * messy in a specific way: the model writes `**"quote"** — [uuid], 1,840
 * reactions...`, so removing just the quoted span leaves `**** — ,` at the
 * front. Returns null when nothing meaningful survives, so the UI shows the
 * pull-quote alone instead of an empty paragraph.
 */
export function hookCommentary(body: string): string | null {
  const withoutQuote = body
    .replace(/[""][^""]{4,300}[""]/, "")
    .replace(/"[^"]{4,300}"/, "");
  const cleaned = cleanInline(withoutQuote);
  return cleaned.length > 12 ? cleaned : null;
}

/**
 * Split WRITE NEXT into individual angles.
 *
 * The prompt asks for two, but the model formats them as "-", "**Name:**", or
 * a numbered list depending on the day. Splitting on leading bullets covers all
 * three; anything unsplittable comes back as one item so the text still shows.
 */
export function splitAngles(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const bulleted = trimmed
    .split(/\n(?=\s*(?:[-*•]|\d+[.)])\s+)/)
    .map((chunk) => chunk.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  return bulleted.length > 1 ? bulleted : [trimmed];
}

/**
 * Strip inline markdown the page renders as plain text.
 *
 * Bold and post-id brackets are noise in a rendered card: the ids are UUIDs the
 * reader cannot act on, and `**` renders literally without a markdown parser.
 * Engagement numbers are kept — those are the evidence.
 */
export function cleanInline(text: string): string {
  return (
    text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      // A post id inside parentheses takes the parens with it. Removing the id
      // alone left "( — 827 reactions, 2,957 comments)" on the rendered page —
      // a dangling bracket that reads as a typo.
      .replace(
        /\(\s*\[?[0-9a-f]{8}-[0-9a-f-]{27,}\]?\s*[—–-]?\s*/gi,
        "(",
      )
      .replace(/\[[0-9a-f]{8}-[0-9a-f-]{27,}\]/gi, "")
      // Leftover emphasis markers. Stripping the quoted hook out of the BEST
      // HOOK body left "**** — ," at the start of the remainder.
      .replace(/\*+/g, "")
      // Punctuation stranded by any of the removals above: a leading dash or
      // comma, or an empty "()".
      .replace(/\(\s*\)/g, "")
      .replace(/^[\s—–,;:-]+/, "")
      .replace(/\(\s*[—–,;:-]\s*/g, "(")
      .replace(/\s+([,.;:)])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/** "2026-08-06" → "Thursday, 6 August" for a header that reads like a date. */
export function formatDigestDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** Relative label for the list rail: today / yesterday / the date. */
export function relativeDigestLabel(isoDate: string, today: Date): string {
  const todayIso = today.toISOString().slice(0, 10);
  if (isoDate === todayIso) return "Today";
  const yesterday = new Date(Date.parse(`${todayIso}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (isoDate === yesterday) return "Yesterday";
  return formatDigestDate(isoDate);
}

/**
 * Post ids the brief cites, in the order the model mentioned them.
 *
 * The digest already embeds real `posts.id` UUIDs — the prompt asks for them so
 * findings can be checked. Nothing about the cron or the stored content changes
 * to support showing the cards; the ids were always there, they were simply
 * stripped for display.
 *
 * Deduped, because the same post is usually cited in both THEME and FORMAT and
 * the reader does not want it twice. Order is preserved so the most-discussed
 * post leads.
 */
export function referencedPostIds(content: string): string[] {
  const matches =
    (content ?? "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ??
    [];
  return [...new Set(matches.map((id) => id.toLowerCase()))];
}
