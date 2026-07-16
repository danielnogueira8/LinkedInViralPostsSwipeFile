// LinkedIn-faithful text formatting.
//
// LinkedIn has no rich-text API — its posts are plain Unicode. "Bold" and
// "italic" in every LinkedIn formatting tool are actually Unicode Mathematical
// Alphanumeric Symbols: regular `a` becomes 𝗮 (bold) or 𝘢 (italic). These
// survive copy-paste into the LinkedIn composer because they're just
// characters, not markup. We mirror that here so what the user formats in the
// draft card is exactly what lands in their post.
//
// The transforms are reversible: applying bold to already-bold text un-bolds
// it (toggle behaviour), so the toolbar buttons feel like a real editor.

// Offsets into the Mathematical Alphanumeric Symbols block. Each style maps the
// ASCII ranges A-Z, a-z, 0-9 to a contiguous Unicode run (digits only exist for
// some styles — bold has them, italic doesn't, so we leave digits untouched
// there).
type StyleMap = {
  upper: number; // code point of styled "A"
  lower: number; // code point of styled "a"
  digit?: number; // code point of styled "0" (omit if the style lacks digits)
};

const STYLES = {
  bold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec }, // sans-serif bold
  italic: { upper: 0x1d608, lower: 0x1d622 }, // sans-serif italic (no digits)
} satisfies Record<string, StyleMap>;

export type FormatStyle = keyof typeof STYLES;

// Build the forward (ascii -> styled) and reverse (styled -> ascii) lookup for
// a style once, at module load.
function buildMaps(map: StyleMap) {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const add = (ascii: number, styled: number) => {
    const a = String.fromCodePoint(ascii);
    const s = String.fromCodePoint(styled);
    forward.set(a, s);
    reverse.set(s, a);
  };
  for (let i = 0; i < 26; i++) {
    add(0x41 + i, map.upper + i); // A-Z
    add(0x61 + i, map.lower + i); // a-z
  }
  if (map.digit !== undefined) {
    for (let i = 0; i < 10; i++) add(0x30 + i, map.digit + i); // 0-9
  }
  return { forward, reverse };
}

const MAPS: Record<FormatStyle, ReturnType<typeof buildMaps>> = {
  bold: buildMaps(STYLES.bold),
  italic: buildMaps(STYLES.italic),
};

function toStyle(text: string, style: FormatStyle): string {
  const { forward } = MAPS[style];
  return [...text].map((ch) => forward.get(ch) ?? ch).join("");
}

function fromStyle(text: string, style: FormatStyle): string {
  const { reverse } = MAPS[style];
  return [...text].map((ch) => reverse.get(ch) ?? ch).join("");
}

// True when every cased/digit character in `text` is already in this style
// (ignoring spaces/punctuation that have no styled form). Used to decide
// whether the toggle should apply or remove the style.
function isStyled(text: string, style: FormatStyle): boolean {
  const { reverse } = MAPS[style];
  const { forward } = MAPS[style];
  let sawStyleable = false;
  for (const ch of text) {
    // A character is "styleable" if it has a forward mapping (i.e. an ascii
    // letter/digit) OR is already a styled char of this style.
    if (forward.has(ch)) {
      sawStyleable = true;
      return false; // a plain styleable char means it's not fully styled
    }
    if (reverse.has(ch)) sawStyleable = true;
  }
  return sawStyleable;
}

// Toggle a style on a selection: if it's already styled, strip it back to
// ascii; otherwise apply it. Returns the transformed string.
export function toggleStyle(selection: string, style: FormatStyle): string {
  if (!selection) return selection;
  return isStyled(selection, style)
    ? fromStyle(selection, style)
    : toStyle(selection, style);
}

// Settle an AI rewrite of a selected span back into place, preserving the
// LINE BREAKS the user's selection carried at its edges. The model often adds
// or drops stray edge whitespace, so we trim its own leading/trailing
// whitespace — but if the ORIGINAL selection started/ended with whitespace
// (most importantly a "\n\n" paragraph break at the edge of the span), we
// re-apply exactly that, so the rewrite doesn't merge two paragraphs into one.
// Pure + exported so the "Ask AI removes a line break" fix is unit-tested.
export function applyRewriteBoundary(
  rewritten: string,
  originalSelection: string,
): string {
  const lead = originalSelection.match(/^\s*/)?.[0] ?? "";
  const trail = originalSelection.match(/\s*$/)?.[0] ?? "";
  return lead + rewritten.trim() + trail;
}

// LinkedIn renders no real bullets, so list tools prefix lines with a bullet
// glyph. We toggle the prefix per line across the selection.
const BULLET = "• ";
const NUMBER_RE = /^\d+\.\s/;

export function toggleBulletList(selection: string): string {
  const lines = selection.split("\n");
  const allBulleted = lines
    .filter((l) => l.trim() !== "")
    .every((l) => l.startsWith(BULLET));
  return lines
    .map((l) => {
      if (l.trim() === "") return l;
      if (allBulleted) return l.slice(BULLET.length);
      // Drop an existing number prefix so toggling between list types is clean.
      return BULLET + l.replace(NUMBER_RE, "");
    })
    .join("\n");
}

export function toggleNumberedList(selection: string): string {
  const lines = selection.split("\n");
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const allNumbered = nonEmpty.every((l) => NUMBER_RE.test(l));
  let n = 0;
  return lines
    .map((l) => {
      if (l.trim() === "") return l;
      if (allNumbered) return l.replace(NUMBER_RE, "");
      n += 1;
      return `${n}. ${l.replace(NUMBER_RE, "").replace(BULLET, "")}`;
    })
    .join("\n");
}

// LinkedIn's composer truncates the visible preview at ~210 characters ("…see
// more") and caps a post at 3,000 characters. Surface both so the user knows
// where their hook gets cut and how close they are to the limit.
export const LINKEDIN_MAX_CHARS = 3000;
export const LINKEDIN_SEE_MORE_CHARS = 210;

// A small, opinionated emoji palette — the ones that actually show up in
// high-performing LinkedIn posts. Grouped so the picker reads sensibly. Kept
// inline (no dependency) to stay light; expand freely.
export const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "Popular",
    emojis: ["🚀", "🔥", "💡", "✅", "👇", "👀", "🎯", "💯", "⚡", "✨", "📈", "🙌"],
  },
  {
    label: "Faces",
    emojis: ["😀", "😅", "🤔", "😎", "🤯", "🥳", "😬", "🙏", "👏", "💪", "🤝", "👍"],
  },
  {
    label: "Objects",
    emojis: ["📌", "📝", "📊", "💰", "⏰", "🎁", "🔑", "🧠", "❤️", "⭐", "🏆", "📣"],
  },
];
