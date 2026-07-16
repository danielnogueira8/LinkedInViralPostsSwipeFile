// Unicode "fonts" for LinkedIn. LinkedIn has NO rich text — a post body is plain
// text — so the only way to render bold/italic is to substitute A–Z / a–z / 0–9
// with look-alike Unicode code points from the Mathematical Alphanumeric Symbols
// block. This is the exact trick every LinkedIn formatting tool uses.
//
// Caveats (intentional, documented):
//   • These are NOT semantically bold — screen readers read them oddly and search
//     may not match them. That is inherent to the LinkedIn-bold hack; users of a
//     LinkedIn tool expect this.
//   • They are astral (multi-code-unit) characters, so a "bolded" 10-char word is
//     more than 10 chars/bytes. Callers that enforce LinkedIn's caption cap must
//     measure AFTER styling (see markdownToLinkedIn callers).
//   • Only A–Z, a–z, 0–9 have variants. Everything else (punctuation, spaces,
//     accented letters, emoji) passes through unchanged.

export type UnicodeStyle = "bold" | "italic" | "boldItalic";

// Base code points of each Mathematical Alphanumeric range. We compute the styled
// char by offset from the ASCII base, which keeps this a tiny lookup instead of a
// 62-entry-per-style literal map. Digits only exist for bold (Unicode has no
// italic/bold-italic digit range), so italic/bold-italic digits fall back to bold
// digits (still visually distinct, never a raw ASCII leak issue).
const RANGES: Record<
  UnicodeStyle,
  { upper: number; lower: number; digit: number | null }
> = {
  // 𝗔..𝗭 / 𝗮..𝘇 / 𝟬..𝟵  (Sans-Serif Bold — reads as bold on LinkedIn, cleaner
  // than Serif Bold which looks like a different typeface).
  bold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  // 𝘈..𝘡 / 𝘢..𝘻  (Sans-Serif Italic). No italic digits → reuse bold digits.
  italic: { upper: 0x1d608, lower: 0x1d622, digit: 0x1d7ec },
  // 𝘼..𝙕 / 𝙖..𝙯  (Sans-Serif Bold Italic). No digits → reuse bold digits.
  boldItalic: { upper: 0x1d63c, lower: 0x1d656, digit: 0x1d7ec },
};

/**
 * Style a run of text with a Unicode look-alike "font". Only ASCII letters and
 * digits are transformed; every other character (punctuation, whitespace,
 * emoji, accented letters) is left exactly as-is.
 */
export function toUnicodeStyle(text: string, style: UnicodeStyle): string {
  const range = RANGES[style];
  let out = "";
  // Iterate by code point (spread) so any astral chars already in `text` are
  // preserved whole rather than split into surrogate halves.
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) {
      out += String.fromCodePoint(range.upper + (code - 0x41)); // A-Z
    } else if (code >= 0x61 && code <= 0x7a) {
      out += String.fromCodePoint(range.lower + (code - 0x61)); // a-z
    } else if (code >= 0x30 && code <= 0x39 && range.digit !== null) {
      out += String.fromCodePoint(range.digit + (code - 0x30)); // 0-9
    } else {
      out += ch;
    }
  }
  return out;
}
