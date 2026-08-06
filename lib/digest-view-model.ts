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

// ---------------------------------------------------------------------------
// Readable section shape.
//
// Every section arrived as ONE dense paragraph with citations inlined, so the
// claim and its evidence had equal weight and you could not find the point
// without reading past the numbers.
//
// The model already separates the two: it opens each section with the claim in
// **bold**, then lists evidence. cleanInline was stripping that emphasis and
// flattening the result. These helpers use the signal instead of discarding it.
// ---------------------------------------------------------------------------

export type SectionLead = {
  /** The claim, if the model marked one. */
  claim: string | null;
  /** Everything after it. */
  evidence: string;
};

/**
 * Split a section into its claim and its supporting evidence.
 *
 * Only treats leading **bold** as the claim — bold appearing mid-paragraph is
 * emphasis, not a heading, and promoting it would put a random phrase in large
 * type. Returns a null claim when the model did not mark one, so the caller
 * renders ordinary prose rather than guessing at a first sentence.
 */
export function splitSectionLead(body: string): SectionLead {
  const match = body.match(/^\s*\*\*([\s\S]+?)\*\*\s*/);
  if (!match) return { claim: null, evidence: cleanInline(body) };
  const claim = cleanInline(match[1]).replace(/[.:;,\s]+$/, "");
  const evidence = cleanInline(body.slice(match[0].length));
  // A claim with no evidence behind it is just the section's only sentence;
  // keep it as prose rather than showing a lead with nothing under it.
  if (!evidence) return { claim: null, evidence: cleanInline(body) };
  return { claim, evidence };
}

export type EvidenceItem = {
  /** The post title, when the model quoted one. */
  title: string | null;
  /** Engagement or other detail. */
  detail: string;
};

/**
 * Break evidence prose into scannable items.
 *
 * Two shapes appear in production: quoted post titles each followed by their
 * numbers ("Complete Claude Revenue System" (827 reactions, 2,957 comments)),
 * and semicolon-separated clauses. Both become one item per post so the eye can
 * run down a column instead of parsing a 429-character sentence.
 *
 * Returns [] when neither shape is present — the caller then renders the
 * evidence as a paragraph, which is correct for a section that genuinely is
 * one continuous thought.
 */
export function splitEvidence(evidence: string): EvidenceItem[] {
  // Title-then-detail pairs. Matches BOTH quote styles: the model emits curly
  // quotes in production, and a straight-quote-only class silently matched
  // nothing — the section fell back to prose and stayed a wall of text.
  //
  // The detail runs to the next opening quote (or the end), so engagement
  // wrapped in "(...)" is captured rather than excluded, which the previous
  // pattern got wrong by forbidding parens in the detail entirely.
  const quoted = [
    ...evidence.matchAll(
      /["\u201C\u201D]([^"\u201C\u201D]+)["\u201C\u201D]([^"\u201C\u201D]*)/g,
    ),
  ];
  if (quoted.length >= 2) {
    return quoted.map((match) => ({
      title: match[1].trim(),
      // Trailing ")" and "." are left over from the inline "(...)" wrapper the
      // model writes around engagement; unbalanced they read as a typo.
      // Trim the connective tissue between items: a leading "(" from the
      // engagement wrapper, and a trailing "), and" / ", and" before the final
      // item — both belong to the sentence, not to this row.
      detail: cleanInline(match[2] ?? "")
        .replace(/^[\s,;:—–(-]+/, "")
        .replace(/[\s,;:—–.)]*\s+and\s*$/i, "")
        .replace(/[\s,;:—–.)-]+$/, ""),
    }));
  }
  const clauses = evidence
    .split(/;\s*/)
    .map((clause) => {
      // The first clause usually carries lead-in prose before a colon
      // ("over-performed as a repeatable structure: the Revenue System
      // generated..."). That preamble restates the claim, so drop it and keep
      // the evidence — otherwise item one reads twice as long as the rest.
      const afterColon = clause.includes(":")
        ? clause.slice(clause.indexOf(":") + 1)
        : clause;
      return cleanInline(afterColon).replace(/^(?:and\s+)?(?:the\s+)?/i, "");
    })
    .map((clause) => clause.replace(/[\s.;,]+$/, ""))
    .filter((clause) => clause.length > 8);
  if (clauses.length >= 2) {
    return clauses.map((clause) => ({ title: null, detail: clause }));
  }
  return [];
}
