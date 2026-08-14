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
const RESPONSE_CTA_VERB = "(?:[Cc]omment|[Dd]rop|[Tt]ype|[Rr]eply\\s+with)";
// "Say" is a valid CTA only when it is an imperative followed by a concrete
// delivery cue. This intentionally excludes narration such as
// "I say 'it's not about the money'".
const IMPERATIVE_SAY_DELIVERY =
  "(?:\\s+below)?\\s+(?:to\\s+get\\b|and\\s+i['’]?ll\\s+(?:dm|send|share)\\b)";

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
  new RegExp(
    `(?:^|[.!?\\n]\\s*)${RESPONSE_CTA_VERB}\\s+([A-Z][A-Z0-9\\-]{2,29})\\b`,
  );
const IMPERATIVE_SAY_ALLCAPS_CTA = new RegExp(
  `(?:^|[.!?\\n]\\s*)[Ss]ay\\s+([A-Z][A-Z0-9\\-]{2,29})\\b${IMPERATIVE_SAY_DELIVERY}`,
);

function matchesAllCapsLeadMagnet(text: string): boolean {
  const m = text.match(ALLCAPS_CTA) ?? text.match(IMPERATIVE_SAY_ALLCAPS_CTA);
  if (!m) return false;
  return !ALLCAPS_STOPLIST.has(m[1]);
}

// The things creators actually give away. Used to keep "giving away" and the
// "free X" patterns anchored to a real resource, so ordinary English ("giving
// away the ending", "free speech") doesn't read as a lead magnet.
const RESOURCE_NOUNS =
  "course|playbook|guide|template|templates|system|toolkit|framework|checklist|swipe\\s*file|prompt|prompts|library|resource|resources|training|workshop|audit|cop(?:y|ies)|breakdown|masterclass|ebook|book|deck|spreadsheet|notion|sop|sops|kit|pack|bundle|access|blueprint|tracker|calculator|database|cheat\\s*sheet";

const LEAD_MAGNET_PATTERNS: RegExp[] = [
  // Pattern A: quoted keyword or number after a CTA verb.
  // "comment 'PLAYBOOK'", "drop 'SCALE' below", "comment '10'"
  // Quotes are REQUIRED here — the unquoted all-caps form is handled by
  // matchesAllCapsLeadMagnet() so prose like "Drop the act" doesn't match.
  new RegExp(`\\b${RESPONSE_CTA_VERB}\\s+${QUOTED_KEYWORD}`, "i"),
  new RegExp(
    `(?:^|[.!?\\n]\\s*)say\\s+${QUOTED_KEYWORD}${IMPERATIVE_SAY_DELIVERY}`,
    "i",
  ),
  // "I'll DM it", "I'll send you the link" — and the uncontracted "I will
  // send you", which real posts use just as often and this missed entirely.
  /\bi(?:['’]?ll|\s+will)\s+(?:dm|send|share)\s+(?:it|you|them|the\s+link)/i,
  // "DM me 'X'", "send me 'X' in DMs"
  new RegExp(`\\b(?:dm|message|send)\\s+me\\s+${KEYWORD}`, "i"),
  // gating: must be connected / follow first
  /\b(?:must\s+be\s+(?:connected|following)|need\s+to\s+(?:be\s+)?(?:connected|follow))/i,
  /\b(?:connect\s+with\s+me|follow\s+me)\s+(?:first|&|and|so\s+i)/i,
  // "comment X for the playbook/template/guide/system/swipe"
  /\bcomment\s+\S+\s+(?:for|to\s+get|and\s+i)\b/i,
  // "want the [thing]? comment/drop X"
  /\bwant\s+(?:the|my|this|a\s+copy)\b[^.?!]{0,80}\?\s*(?:comment|drop|reply|dm)\b/i,

  // ---------------------------------------------------------------------
  // GIVEAWAY-FIRST CTAs.
  //
  // The patterns above all assume the post names a mechanism — comment this
  // keyword, DM me that word. A lot of lead magnets now just announce the
  // giveaway and point down ("Get free access below 👇", "I'm giving away the
  // full course for free"), leaving the mechanism implicit. Those were
  // classified as regular posts, which sends them to the wrong discovery
  // threshold: lead magnets qualify on comments, regular posts on likes.
  // ---------------------------------------------------------------------

  // "I'm giving away…", "we're giving away…". Anchored on a first-person
  // subject so the idiom ("that's giving away the ending", "giving away my
  // age") doesn't trip it.
  /\b(?:i['’]?m|i\s+am|we['’]?re|we\s+are|i['’]?ll\s+be)\s+giving\s+(?:it\s+|them\s+|these\s+)?away\b/i,
  // "giving away my playbook", "giving away the full course".
  //
  // A determiner alone is NOT enough: "that's giving away the ending" and
  // "giving away the game" are ordinary idioms and were false-positiving. The
  // object has to be an actual resource, with room for a couple of adjectives
  // in between ("giving away the full course").
  new RegExp(
    `\\bgiving\\s+away\\s+(?:my|our|the|a|an|all|\\d+)\\s+(?:\\w+\\s+){0,2}(?:${RESOURCE_NOUNS})`,
    "i",
  ),
  // "sharing it for free", "handing this out for free"
  /\b(?:giving|sharing|sending|handing)\s+(?:it|them|this|these|everything|all\s+of\s+it)?\s*(?:out\s+)?for\s+free\b/i,

  // "Free access." / "get free access below 👇" / "free copy" / "complimentary
  // audit". `access` is in the noun list, so the phrasing that prompted this
  // is covered here rather than by a rule of its own — a separate
  // /\bfree\s+access\b/ was redundant, which mutation testing caught by
  // deleting it and watching every test still pass.
  //
  // The noun list is what keeps this from firing on every use of "free"
  // ("free speech", "feel free to disagree").
  new RegExp(`\\b(?:free|complimentary)\\s+(?:${RESOURCE_NOUNS})\\b`, "i"),
  // "grab it free", "download yours for free", "claim your copy free"
  /\b(?:grab|get|download|claim|snag|take)\s+(?:it|yours|your\s+copy|the\s+\w+)\s+(?:for\s+)?free\b/i,
];

// Cap input length before running the regex sweep. LinkedIn posts max out
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
//   • A hook stays a hook (never auto-promoted to lead_magnet).
//   • A post carrying a giveaway (meta.lead_magnet) IS a lead magnet — the
//     giveaway only makes sense on a lead-magnet post, so it overrides even an
//     explicit "post" choice (which usually means the kind simply wasn't
//     reclassified when the giveaway got attached).
//   • An EXPLICIT kind otherwise always wins — a user's manual choice must
//     never be re-classified away on a later save/refine.
//   • Otherwise, auto-classify the body: a post whose text trips the lead-magnet
//     detector (the same classifyPost used on scraped posts) becomes
//     'lead_magnet'; else 'post'. So a lead magnet written in Cowork is tagged
//     correctly without the user doing anything.
// Pure + exported for tests.
export function resolveDraftKind(
  explicit: DraftKind | null | undefined,
  body: string | null | undefined,
  opts?: { hasLeadMagnet?: boolean },
): DraftKind {
  if (explicit === "hook") return explicit; // a hook stays a hook
  if (opts?.hasLeadMagnet) return "lead_magnet"; // a giveaway forces the kind
  if (explicit) return explicit; // manual choice wins
  return classifyPost(body ?? "").post_type === "lead_magnet"
    ? "lead_magnet"
    : "post";
}
