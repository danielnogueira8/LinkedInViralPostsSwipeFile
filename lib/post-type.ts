export type PostType = "regular" | "lead_magnet";

export function resolveModelSourcePostType(
  storedPostType: unknown,
  text: string | null | undefined,
): PostType {
  return normalizePostType(storedPostType) ?? classifyPost(text ?? null).post_type;
}
export type DetectedVia = "regex" | null;

// The valid post_type values, for guarding untrusted query params.
export const POST_TYPES: readonly PostType[] = ["regular", "lead_magnet"];

// Normalize an untrusted ?type= value to a known PostType, or null (= all
// types). Shared by the swipe file and bookmarks post-type filters.
export function normalizePostType(raw: unknown): PostType | null {
  return raw === "regular" || raw === "lead_magnet" ? raw : null;
}

// CTA patterns that almost always mean a lead magnet. Quote chars include
// straight and curly because LinkedIn mangles them either way.
const Q_OPEN = `["'“‘]`;
const Q_CLOSE = `["'”’]`;
const Q = `["'“”‘’]`;
// KEYWORD allows optional quotes — used by the DM-me pattern further down
// where a bare keyword is still a strong signal in context ("DM me playbook").
const KEYWORD = `${Q}?[A-Za-z0-9][A-Za-z0-9 \\-_!?]{1,29}${Q}?`;
// QUOTED_KEYWORD requires quotes on both sides — used by Pattern A so that
// "Drop the act" doesn't get flagged but "Drop 'SCALE'" does.
const QUOTED_KEYWORD = `${Q_OPEN}[A-Za-z0-9][A-Za-z0-9 \\-_!?]{0,29}${Q_CLOSE}`;

// Common English emphasis words that show up in ALL CAPS but aren't lead-magnet
// keywords. Without this, "Drop ONE thing you'd change" gets flagged. YES/NO
// are in here too — real "comment YES" lead magnets still get rescued by the
// ratio fallback further down.
const ALLCAPS_STOPLIST = new Set([
  "ONE", "TWO", "THREE", "FOUR", "FIVE",
  "YES", "NO",
  "THIS", "THAT", "ANY", "ALL",
  "YOUR", "MY", "THE", "AN",
]);

// Unquoted ALL-CAPS keyword after a CTA verb. Verb must be at sentence start
// (start of string or after . ! ? \n) so "She'll comment GREAT..." doesn't
// match. Keyword group is strictly all-caps (no /i flag) so lowercase prose
// can't slip through. Stop-listed keywords are filtered out before returning.
const ALLCAPS_CTA =
  /(?:^|[.!?\n]\s*)(?:[Cc]omment|[Dd]rop|[Tt]ype|[Rr]eply with|[Ss]ay)\s+([A-Z][A-Z0-9\-]{2,29})\b/;

function matchesAllCapsLeadMagnet(text: string): boolean {
  const m = text.match(ALLCAPS_CTA);
  if (!m) return false;
  return !ALLCAPS_STOPLIST.has(m[1]);
}

const LEAD_MAGNET_PATTERNS: RegExp[] = [
  // Pattern A: quoted keyword or number after a CTA verb.
  // "comment 'PLAYBOOK'", "drop 'SCALE' below", "comment '10'"
  // Quotes are REQUIRED here — the unquoted all-caps form is handled by
  // matchesAllCapsLeadMagnet() so prose like "Drop the act" doesn't match.
  new RegExp(`\\b(?:comment|drop|type|reply\\s+with|say)\\s+${QUOTED_KEYWORD}`, "i"),
  // "I'll DM it", "I'll send you the link"
  /\bi['’]?ll\s+(?:dm|send|share)\s+(?:it|you|them|the\s+link)/i,
  // "DM me 'X'", "send me 'X' in DMs"
  new RegExp(`\\b(?:dm|message|send)\\s+me\\s+${KEYWORD}`, "i"),
  // gating: must be connected / follow first
  /\b(?:must\s+be\s+(?:connected|following)|need\s+to\s+(?:be\s+)?(?:connected|follow))/i,
  /\b(?:connect\s+with\s+me|follow\s+me)\s+(?:first|&|and|so\s+i)/i,
  // "comment X for the playbook/template/guide/system/swipe"
  /\bcomment\s+\S+\s+(?:for|to\s+get|and\s+i)\b/i,
  // "want the [thing]? comment/drop X"
  /\bwant\s+(?:the|my|this|a\s+copy)\b[^.?!]{0,80}\?\s*(?:comment|drop|reply|dm)\b/i,
];

// Cap input length before running the 7-regex sweep. LinkedIn posts max out
// around 3000 chars, so anything longer is either an outlier or a scraper
// quirk (concatenated paragraphs, hidden HTML). Patterns include bounded
// `{0,80}` quantifiers so the regexes themselves aren't catastrophic, but
// running them sequentially across megabyte-sized blobs would still burn
// CPU during a hot scrape. 5000 is safely above real posts.
const CLASSIFY_MAX_CHARS = 5000;

export function classifyPost(
  text: string | null,
): { post_type: PostType; detected_via: DetectedVia } {
  if (text) {
    const sample = text.length > CLASSIFY_MAX_CHARS ? text.slice(0, CLASSIFY_MAX_CHARS) : text;
    for (const re of LEAD_MAGNET_PATTERNS) {
      if (re.test(sample)) return { post_type: "lead_magnet", detected_via: "regex" };
    }
    if (matchesAllCapsLeadMagnet(sample)) {
      return { post_type: "lead_magnet", detected_via: "regex" };
    }
  }
  return { post_type: "regular", detected_via: null };
}

// The three content KINDs a draft can be. 'post' = a regular post, 'lead_magnet'
// = a gated-CTA post, 'hook' = a single opener. (Distinct from a draft's STATUS
// — idea/drafting/ready/posted — which is where it sits in the pipeline.)
export type DraftKind = "post" | "hook" | "lead_magnet";

// Resolve the KIND for a draft being created/saved. RULES:
//   • An EXPLICIT kind always wins — a user's manual choice must never be
//     re-classified away on a later save/refine.
//   • A hook stays a hook (never auto-promoted to lead_magnet).
//   • Otherwise, auto-classify the body: a post whose text trips the lead-magnet
//     detector (the same classifyPost used on scraped posts) becomes
//     'lead_magnet'; else 'post'. So a lead magnet written in Cowork is tagged
//     correctly without the user doing anything.
// Pure + exported for tests.
export function resolveDraftKind(
  explicit: DraftKind | null | undefined,
  body: string | null | undefined,
): DraftKind {
  if (explicit) return explicit; // manual choice wins
  return classifyPost(body ?? "").post_type === "lead_magnet"
    ? "lead_magnet"
    : "post";
}
