export type PostType = "regular" | "lead_magnet";
export type DetectedVia = "regex" | "ratio" | null;

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

export function classifyPost(
  text: string | null,
  reactions: number,
  comments: number,
): { post_type: PostType; detected_via: DetectedVia } {
  if (text) {
    for (const re of LEAD_MAGNET_PATTERNS) {
      if (re.test(text)) return { post_type: "lead_magnet", detected_via: "regex" };
    }
    if (matchesAllCapsLeadMagnet(text)) {
      return { post_type: "lead_magnet", detected_via: "regex" };
    }
  }
  // Ratio fallback: lead magnets force engagement into the comments, so
  // comments/reactions ratio runs much higher than normal posts. Require an
  // absolute floor so we don't flag tiny posts with 5 likes / 3 comments.
  if (comments >= 50 && reactions > 0 && comments / reactions >= 0.4) {
    return { post_type: "lead_magnet", detected_via: "ratio" };
  }
  return { post_type: "regular", detected_via: null };
}
