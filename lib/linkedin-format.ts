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

// Strikethrough can't use the Mathematical Alphanumeric ranges above — there is
// no struck-through alphabet in Unicode. LinkedIn tools do it the only way that
// survives a paste: COMBINING LONG STROKE OVERLAY (U+0336) after every visible
// character, which the renderer draws as a line through the glyph.
//
// Two consequences worth knowing, both intentional:
//   • it roughly DOUBLES the string's length, and LinkedIn counts those
//     combining marks against the 3,000 cap — so the counter moving faster than
//     the visible text is correct, not a bug.
//   • it composes with bold/italic (the mark attaches to the styled glyph), so
//     the toggles stay independent of each other.
// Written as an escape on purpose: as a literal it is an invisible zero-width
// combining mark in the source, which reads like a typo and invites deletion.
const STRIKE = "\u0336";

// Don't attach a mark to whitespace: a combining mark on a space renders as a
// floating dash and, at the end of a selection, leaves a stray stroke behind.
function isStruck(text: string): boolean {
  const visible = [...text].filter((ch) => ch !== STRIKE && ch.trim() !== "");
  if (visible.length === 0) return false;
  // Struck when every visible character is immediately followed by the mark.
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === STRIKE || ch.trim() === "") continue;
    if (chars[i + 1] !== STRIKE) return false;
  }
  return true;
}

/** Toggle Unicode strikethrough across a selection (U+0336 combining mark). */
export function toggleStrikethrough(selection: string): string {
  if (!selection) return selection;
  if (isStruck(selection)) return selection.split(STRIKE).join("");
  return [...selection]
    .map((ch) => (ch.trim() === "" ? ch : ch + STRIKE))
    .join("");
}

/**
 * Strip every LinkedIn formatting affordance back to plain ASCII: Unicode
 * bold/italic, strikethrough marks, and bullet/number list prefixes. This is the
 * "clear formatting" escape hatch — the styles are real characters, so once a
 * body has been through a few toggles the only reliable way back is to undo all
 * of them at once.
 */
export function clearFormatting(selection: string): string {
  if (!selection) return selection;
  let out = selection.split(STRIKE).join("");
  for (const style of Object.keys(MAPS) as FormatStyle[]) {
    out = fromStyle(out, style);
  }
  return out
    .split("\n")
    .map((line) =>
      line.startsWith(BULLET)
        ? line.slice(BULLET.length)
        : line.replace(NUMBER_RE, ""),
    )
    .join("\n");
}

// The glyphs that actually earn their place in a LinkedIn post: an arrow for
// consequence, a bullet for a list item, a turn-arrow for a nested beat, and a
// ballot box for a checklist. Kept as literal characters because that is what
// LinkedIn stores — there is no markup to convert.
export const SPECIAL_CHARS: { char: string; label: string }[] = [
  { char: "→", label: "Arrow" },
  { char: "•", label: "Bullet" },
  { char: "↳", label: "Nested arrow" },
  { char: "☑", label: "Checkbox" },
];

// LinkedIn's composer truncates the visible preview at ~210 characters ("…see
// more") and caps a post at 3,000 characters. Surface both so the user knows
// where their hook gets cut and how close they are to the limit.
export const LINKEDIN_MAX_CHARS = 3000;
export const LINKEDIN_SEE_MORE_CHARS = 210;

// Warn before the wall, not at it: past this share of the cap the counter turns
// amber so a long draft is a decision, not a surprise at publish time.
export const LINKEDIN_WARN_CHARS = Math.round(LINKEDIN_MAX_CHARS * 0.9);

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
