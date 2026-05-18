export type PostType = "regular" | "lead_magnet";
export type DetectedVia = "regex" | "ratio" | null;

// CTA patterns that almost always mean a lead magnet. Quote chars include
// straight and curly because LinkedIn mangles them either way.
const Q = `["'“”‘’]`;
const KEYWORD = `${Q}?[A-Za-z0-9][A-Za-z0-9 \\-_!?]{1,29}${Q}?`;

const LEAD_MAGNET_PATTERNS: RegExp[] = [
  // "comment 'PLAYBOOK'", "drop 'SCALE' below"
  new RegExp(`\\b(?:comment|drop|type|reply\\s+with|say)\\s+${KEYWORD}\\s*(?:below|in\\s+the\\s+comments?)?\\b`, "i"),
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
  }
  // Ratio fallback: lead magnets force engagement into the comments, so
  // comments/reactions ratio runs much higher than normal posts. Require an
  // absolute floor so we don't flag tiny posts with 5 likes / 3 comments.
  if (comments >= 50 && reactions > 0 && comments / reactions >= 0.4) {
    return { post_type: "lead_magnet", detected_via: "ratio" };
  }
  return { post_type: "regular", detected_via: null };
}
