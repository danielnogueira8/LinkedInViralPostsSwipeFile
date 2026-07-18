// Deterministic writing-mechanics fingerprint — the surface-level habits a
// creator's own posts encode (capitalization, punctuation, emoji, whitespace)
// that an LLM asked to "notice punctuation and capitalization habits" tends to
// describe vaguely or miss. Measuring these in code instead of asking a model
// to eyeball them means the numbers are facts, not a guess: they never
// hallucinate, they're free (no LLM call), and they're stable across re-runs
// of voice synthesis.
//
// This is intentionally narrow — mechanics only, no topic/tone/structure (that
// stays the synthesis model's job). Computed once from the creator's own
// scraped posts and stored on the VoiceProfile so the writer prompt can quote
// hard numbers ("87% of your sentences start lowercase") instead of a fuzzy
// free-text description.

export type MechanicsFingerprint = {
  // Fraction of sentence-starts (post start + after .!?) that begin with a
  // lowercase letter, vs capitalized. 0 = always capitalizes, 1 = always
  // lowercase. Only counted when the first character is a letter (so a
  // sentence starting with a number/emoji/quote doesn't count either way).
  lowercase_sentence_starts: number;
  // Fraction of standalone "i" tokens (the pronoun, not part of a longer
  // word) that are written lowercase vs capitalized "I".
  lowercase_pronoun_i: number;
  // Fraction of ALPHABETIC WORDS (2+ letters, so not stray single-letter
  // caps) that are ALL CAPS — the deliberate-emphasis tell ("NEVER",
  // "ACTUALLY").
  all_caps_word_rate: number;
  // Em-dash (—) occurrences per 100 words. High rate = the user genuinely
  // writes with em-dashes (the anti-slop em-dash net should back off).
  em_dash_per_100_words: number;
  // Ellipsis ("..." or "…") occurrences per 100 words.
  ellipsis_per_100_words: number;
  // Exclamation mark occurrences per 100 words.
  exclamation_per_100_words: number;
  // Fraction of posts containing at least one comma splice — two independent
  // clauses joined only by a comma (a deliberate run-on style some writers
  // use for pace). Heuristic, not a grammar parser.
  comma_splice_rate: number;
  // Total emoji count across all posts, divided by post count — average
  // emoji per post. 0 means the user essentially never uses emoji.
  emoji_per_post: number;
  // Where emoji tend to appear: "start" (opens a line), "end" (closes a
  // line/post), "inline" (mid-sentence), or "none" (fewer than 2 emoji total
  // — not enough signal to call a placement pattern).
  emoji_placement: "start" | "end" | "inline" | "none";
  // Median number of sentences per paragraph (paragraphs split on blank
  // lines). Low (1) = the user writes single-line paragraphs; higher = dense
  // blocks.
  median_sentences_per_paragraph: number;
  // Fraction of posts that use a list (lines starting with "-", "•", "→",
  // "*", or "1.") anywhere in the body.
  uses_lists_rate: number;
  // The single most common list marker across posts that use one, or null if
  // uses_lists_rate is 0. e.g. "→", "-", "•".
  dominant_list_marker: string | null;
  // Median word count per post — a coarse length tendency, deterministic
  // counterpart to format_patterns.length's free-text description.
  median_words_per_post: number;
  // How many posts this fingerprint was computed from. Callers should treat a
  // fingerprint from very few posts as low-confidence.
  sample_size: number;
};

// Below this many usable posts, per-signal ratios are too noisy to trust —
// callers should still get a fingerprint (never throw), but the caller can
// check sample_size against this constant to decide whether to present it as
// confident guidance.
export const MIN_CONFIDENT_SAMPLES = 8;

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// Stateless emoji check — builds a FRESH regex per call instead of reusing a
// shared global one, so there's no `lastIndex` state to accidentally leak
// between calls (the classic global-regex `.test()` footgun).
function containsEmoji(s: string): boolean {
  return /\p{Extended_Pictographic}/u.test(s);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function wordCount(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+/gu);
  return matches ? matches.length : 0;
}

// Split a post into paragraphs on blank lines (matches the rest of the
// codebase's paragraph convention, e.g. normalizePostBody).
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Split a paragraph into rough sentences on terminal punctuation. Good enough
// for a ratio metric — doesn't need to be a real sentence tokenizer.
function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Every sentence-start across the whole post: the post's own first sentence
// plus every sentence immediately following terminal punctuation. Only
// letter-first sentences count toward the ratio (a sentence opening with a
// number, quote mark, or emoji is neither a capitalization nor a
// lowercase-start signal).
function sentenceStarts(text: string): string[] {
  const starts: string[] = [];
  for (const paragraph of paragraphsOf(text)) {
    for (const sentence of sentencesOf(paragraph)) {
      const first = sentence.match(/[\p{L}]/u);
      if (first && sentence.trimStart().startsWith(first[0])) {
        starts.push(sentence.trimStart());
      }
    }
  }
  return starts;
}

function lowercaseSentenceStartRatio(posts: string[]): number {
  let lower = 0;
  let total = 0;
  for (const post of posts) {
    for (const sentence of sentenceStarts(post)) {
      const ch = sentence[0];
      if (ch === ch.toUpperCase() && ch === ch.toLowerCase()) continue; // not alphabetic-cased
      total++;
      if (ch === ch.toLowerCase() && ch !== ch.toUpperCase()) lower++;
    }
  }
  return total > 0 ? lower / total : 0;
}

function lowercasePronounIRatio(posts: string[]): number {
  let lower = 0;
  let total = 0;
  for (const post of posts) {
    // Standalone "i"/"I" — word-boundaries on both sides so "it", "I'm" etc
    // resolve correctly ("I'm" still starts with the bare pronoun token).
    const matches = post.match(/\b[Ii](?=['’]|\b)/g) ?? [];
    for (const m of matches) {
      total++;
      if (m === "i") lower++;
    }
  }
  return total > 0 ? lower / total : 0;
}

function allCapsWordRate(posts: string[]): number {
  let capsWords = 0;
  let totalWords = 0;
  for (const post of posts) {
    const words = post.match(/[\p{L}]{2,}/gu) ?? [];
    for (const w of words) {
      totalWords++;
      if (w === w.toUpperCase() && w !== w.toLowerCase()) capsWords++;
    }
  }
  return totalWords > 0 ? capsWords / totalWords : 0;
}

function perHundredWords(posts: string[], pattern: RegExp): number {
  let hits = 0;
  let words = 0;
  for (const post of posts) {
    const matches = post.match(pattern);
    hits += matches ? matches.length : 0;
    words += wordCount(post);
  }
  return words > 0 ? (hits / words) * 100 : 0;
}

// Heuristic comma-splice detector: a comma directly joining two clauses that
// each look like an independent clause (has its own subject-shaped run of
// words before a verb-ish word) is hard without real parsing, so we use a
// conservative proxy — a comma followed by a capitalized-or-pronoun-led clause
// of 3+ words, immediately preceded by a clause of 3+ words, with NO
// coordinating conjunction (and/or/but/so/yet/nor) right after the comma.
// Deliberately loose (may under- or over-count individual instances) — it's
// used only as a per-post yes/no signal aggregated into a rate, not a precise
// count.
const COMMA_SPLICE = /[\p{L}\p{N}]{3,}(?:\s+[\p{L}\p{N}']+){2,},\s+(?!and\b|or\b|but\b|so\b|yet\b|nor\b)[A-Z\p{Lu}][\p{L}]*(?:\s+[\p{L}\p{N}']+){2,}[.!?]/u;

function commaSpliceRate(posts: string[]): number {
  if (posts.length === 0) return 0;
  const withSplice = posts.filter((p) => COMMA_SPLICE.test(p)).length;
  return withSplice / posts.length;
}

function emojiStats(posts: string[]): {
  perPost: number;
  placement: MechanicsFingerprint["emoji_placement"];
} {
  let total = 0;
  let start = 0;
  let end = 0;
  let inline = 0;
  for (const post of posts) {
    const lines = post.split("\n");
    for (const line of lines) {
      const matches = [...line.matchAll(EMOJI_RE)];
      if (matches.length === 0) continue;
      total += matches.length;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const firstIsEmoji = containsEmoji(trimmed.slice(0, 2));
      const lastIsEmoji = containsEmoji(trimmed.slice(-2));
      if (firstIsEmoji) start++;
      else if (lastIsEmoji) end++;
      else inline++;
    }
  }
  const perPost = posts.length > 0 ? total / posts.length : 0;
  if (total < 2) return { perPost, placement: "none" };
  const max = Math.max(start, end, inline);
  const placement: MechanicsFingerprint["emoji_placement"] =
    max === 0 ? "none" : max === start ? "start" : max === end ? "end" : "inline";
  return { perPost, placement };
}

function medianSentencesPerParagraph(posts: string[]): number {
  const counts: number[] = [];
  for (const post of posts) {
    for (const paragraph of paragraphsOf(post)) {
      counts.push(sentencesOf(paragraph).length);
    }
  }
  return median(counts);
}

const LIST_MARKER_RE = /^\s*([-•→*]|\d+\.)\s+/;

function listStats(posts: string[]): {
  usesListsRate: number;
  dominantMarker: string | null;
} {
  let usingLists = 0;
  const markerCounts = new Map<string, number>();
  for (const post of posts) {
    const lines = post.split("\n");
    let postHasList = false;
    for (const line of lines) {
      const m = line.match(LIST_MARKER_RE);
      if (!m) continue;
      postHasList = true;
      const marker = /^\d+\./.test(m[1]) ? "1." : m[1];
      markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
    }
    if (postHasList) usingLists++;
  }
  let dominantMarker: string | null = null;
  let best = 0;
  for (const [marker, count] of markerCounts) {
    if (count > best) {
      best = count;
      dominantMarker = marker;
    }
  }
  return {
    usesListsRate: posts.length > 0 ? usingLists / posts.length : 0,
    dominantMarker,
  };
}

function medianWordsPerPost(posts: string[]): number {
  return median(posts.map(wordCount));
}

// Compute the mechanics fingerprint from a creator's own raw post bodies.
// Pure, synchronous, no model call. Empty/whitespace-only posts are dropped
// before measurement. Returns a zeroed/neutral fingerprint (sample_size: 0)
// for an empty input rather than throwing — callers decide whether to attach
// or omit it.
export function computeMechanicsFingerprint(
  posts: string[],
): MechanicsFingerprint {
  const usable = posts.map((p) => p.trim()).filter(Boolean);
  const { perPost: emojiPerPost, placement: emojiPlacement } =
    emojiStats(usable);
  const { usesListsRate, dominantMarker } = listStats(usable);
  return {
    lowercase_sentence_starts: lowercaseSentenceStartRatio(usable),
    lowercase_pronoun_i: lowercasePronounIRatio(usable),
    all_caps_word_rate: allCapsWordRate(usable),
    em_dash_per_100_words: perHundredWords(usable, /—/g),
    ellipsis_per_100_words: perHundredWords(usable, /\.{3}|…/g),
    exclamation_per_100_words: perHundredWords(usable, /!/g),
    comma_splice_rate: commaSpliceRate(usable),
    emoji_per_post: emojiPerPost,
    emoji_placement: emojiPlacement,
    median_sentences_per_paragraph: medianSentencesPerParagraph(usable),
    uses_lists_rate: usesListsRate,
    dominant_list_marker: dominantMarker,
    median_words_per_post: medianWordsPerPost(usable),
    sample_size: usable.length,
  };
}

// Render the fingerprint as a short, human-readable rule list for injection
// into a writer prompt — hard numbers turned into imperative instructions, so
// the model reads "lowercase your sentence starts" instead of a raw ratio it
// has to interpret itself. Only emits a rule when the signal is strong enough
// to be a genuine habit (not a coin-flip or a one-off): thresholds are
// deliberately conservative so this never invents a tic the user doesn't
// actually have. Returns an empty array when sample_size is below
// MIN_CONFIDENT_SAMPLES (too little evidence to assert anything).
export function mechanicsFingerprintToRules(
  fp: MechanicsFingerprint,
): string[] {
  if (fp.sample_size < MIN_CONFIDENT_SAMPLES) return [];
  const rules: string[] = [];
  if (fp.lowercase_sentence_starts >= 0.6) {
    rules.push(
      `Lowercase the first letter of most sentences (observed in ${Math.round(fp.lowercase_sentence_starts * 100)}% of this writer's sentence starts) — do not auto-capitalize.`,
    );
  } else if (fp.lowercase_sentence_starts <= 0.05) {
    rules.push("Always capitalize the first letter of every sentence — this writer never lowercases sentence starts.");
  }
  if (fp.lowercase_pronoun_i >= 0.5) {
    rules.push(`Write the pronoun as lowercase "i", not "I" (observed in ${Math.round(fp.lowercase_pronoun_i * 100)}% of uses).`);
  }
  if (fp.all_caps_word_rate >= 0.01) {
    rules.push("Occasionally use ALL CAPS on a single word for emphasis, the way this writer does — sparingly, never a whole sentence.");
  }
  if (fp.em_dash_per_100_words >= 0.3) {
    rules.push("This writer genuinely uses em dashes (—) — keep them; do not strip or replace them with commas.");
  } else if (fp.em_dash_per_100_words === 0) {
    rules.push("Never use an em dash (—) — this writer doesn't use them.");
  }
  if (fp.exclamation_per_100_words >= 1) {
    rules.push("Use exclamation marks with the same frequency this writer does — don't flatten them to periods.");
  } else if (fp.exclamation_per_100_words === 0) {
    rules.push("Never use exclamation marks — this writer doesn't use them.");
  }
  if (fp.ellipsis_per_100_words >= 0.3) {
    rules.push("This writer uses ellipses (...) — keep that habit when it fits the rhythm.");
  }
  if (fp.emoji_per_post >= 0.5 && fp.emoji_placement !== "none") {
    const where =
      fp.emoji_placement === "start"
        ? "at the start of a line"
        : fp.emoji_placement === "end"
          ? "at the end of a line or the post"
          : "inline, mid-sentence";
    rules.push(`Use emoji sparingly and ${where}, matching this writer's ~${fp.emoji_per_post.toFixed(1)} emoji per post — never emoji-decorate every line.`);
  } else if (fp.emoji_per_post < 0.1) {
    rules.push("Never use emoji — this writer doesn't use them.");
  }
  if (fp.uses_lists_rate >= 0.3 && fp.dominant_list_marker) {
    rules.push(`When writing a list, use "${fp.dominant_list_marker}" as the marker — that's this writer's usual choice.`);
  }
  if (fp.median_sentences_per_paragraph <= 1.2) {
    rules.push("Keep paragraphs to one sentence each (occasionally two) — this writer favors short, single-line paragraphs.");
  }
  return rules;
}
