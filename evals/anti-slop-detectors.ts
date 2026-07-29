// Anti-AI-slop structural detectors.
//
// Pure, deterministic checks for the structural patterns the global writing
// skill (lib/agent/skills/index.ts GLOBAL_WRITING_SKILL) bans — the ones a human
// reader (and a classifier) uses to spot AI text even when the vocabulary is
// clean. Used by:
//   • the unit suite (evals/data/anti-slop-detectors.test.ts) — exhaustive,
//     fast, deterministic checks that the detectors themselves are correct, and
//   • the live suite — run a REAL model draft through them so a regression like
//     the "Not 5. Not 10. Two." rule-of-three draft fails CI instead of shipping.
//
// These are intentionally CONSERVATIVE: a detector fires only on a clear pattern,
// so a false positive doesn't fail a legitimately-human draft. Each returns the
// offending spans so a failure message can point at the exact problem.

// ---- text helpers ---------------------------------------------------------

// Split prose into sentences. Good-enough for English LinkedIn prose: split on
// ., !, ? followed by whitespace, keeping abbreviations from over-splitting is
// out of scope (the drafts here are plain prose). One-line "fragments" (a line
// with no terminal punctuation) count as their own sentence.
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Word count of a sentence/fragment (markers + punctuation stripped).
export function wordCount(s: string): number {
  const m = s.trim().match(/[A-Za-z0-9'’]+/g);
  return m ? m.length : 0;
}

// ---- rule of three --------------------------------------------------------
//
// The headline tell. We catch the two shapes that actually show up:
//   (a) a "staccato triad" — exactly three consecutive SHORT fragments/sentences
//       inside one line, like "Not 5. Not 10. Two." or "Numbers, timeframes,
//       names." (the comma-list form), where there's no fourth beat; and
//   (b) a parallel triad — three consecutive lines/sentences that are short and
//       structurally parallel.
// We require the run to be exactly three (two is fine, four+ is fine) and short,
// to avoid flagging a legitimate enumerated list of three substantial items.

export type ThreeHit = { kind: "staccato" | "comma-list"; text: string };

// A comma-list triad in a single clause: "a, b, c." with exactly three short
// items and no "and"/"or" before the last (an Oxford "a, b, and c" is normal
// human writing; the AI tell is the bare "a, b, c." cadence).
function commaListTriads(text: string): ThreeHit[] {
  const hits: ThreeHit[] = [];
  // Three comma-separated short items ending the clause at . ! ? or line end.
  // Each item: 1-4 words, no internal comma. No "and"/"or" anywhere in the run.
  const re =
    /(?:^|[.!?]\s|:\s)([A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3}),\s([A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3}),\s([A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3})\s*(?=[.!?]|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const run = `${m[1]}, ${m[2]}, ${m[3]}`;
    if (/\b(and|or)\b/i.test(run)) continue; // "a, b, and c" is fine
    hits.push({ kind: "comma-list", text: run.trim() });
  }
  return hits;
}

// A staccato triad: exactly three consecutive SHORT sentences (≤4 words each)
// with no fourth short one immediately after — "Not 5. Not 10. Two." Splitting
// into sentences first, we scan windows of three.
function staccatoTriads(text: string): ThreeHit[] {
  const hits: ThreeHit[] = [];
  const sents = splitSentences(text);
  const short = sents.map((s) => wordCount(s) > 0 && wordCount(s) <= 4);
  for (let i = 0; i + 2 < sents.length; i++) {
    if (short[i] && short[i + 1] && short[i + 2]) {
      // Require it to be EXACTLY three: not preceded or followed by another
      // short sentence (4+ in a row is a different, deliberate rhythm).
      const beforeShort = i > 0 && short[i - 1];
      const afterShort = i + 3 < sents.length && short[i + 3];
      if (!beforeShort && !afterShort) {
        hits.push({
          kind: "staccato",
          text: `${sents[i]} ${sents[i + 1]} ${sents[i + 2]}`,
        });
        i += 2;
      }
    }
  }
  return hits;
}

// All rule-of-three hits in the text.
export function findRuleOfThree(text: string): ThreeHit[] {
  return [...staccatoTriads(text), ...commaListTriads(text)];
}

// ---- uniform sentence length ----------------------------------------------
//
// A run of consecutive sentences of near-identical length is an AI tell, but
// THREE such sentences is common in good prose too, so we flag a run of FOUR or
// more (a clearer, lower-false-positive signal) whose word counts are all within
// ±1 of each other AND are non-trivial (≥5 words — a run of tiny fragments is
// the staccato check's job, not this one).

export function findUniformLengthRun(text: string, minRun = 4): string[][] {
  const sents = splitSentences(text).filter((s) => wordCount(s) >= 5);
  const runs: string[][] = [];
  let run: string[] = [];
  for (let i = 0; i < sents.length; i++) {
    if (run.length === 0) {
      run = [sents[i]];
      continue;
    }
    if (Math.abs(wordCount(sents[i]) - wordCount(run[run.length - 1])) <= 1) {
      run.push(sents[i]);
    } else {
      if (run.length >= minRun) runs.push(run);
      run = [sents[i]];
    }
  }
  if (run.length >= minRun) runs.push(run);
  return runs;
}

// ---- parataxis ------------------------------------------------------------
//
// The AI parataxis tell is MONOTONY: a run of chained declaratives that are not
// just short and connective-free, but also of SIMILAR LENGTH — "Short sentence.
// Then another. Then another." Each ~3 words, no variation. Expressive human
// fragments ("Curiosity. Friction. A claim that contradicts what they believe.
// A number that seems wrong until they read the next line.") vary in length and
// carry rhythm — those are a FEATURE, not the tell. So we require, for a run to
// count: ≥4 consecutive blunt (≤8-word, connective-free) sentences whose lengths
// are also nearly uniform (max−min ≤ 2 words). Varied-length fragment runs and
// runs of three pass. This keeps the detector from failing good punchy voice.

const CONNECTIVE_RE =
  /\b(because|so|but|which|while|since|although|though|and|or|whereas|yet|if|when)\b|;/i;

export function findParataxisRun(text: string, minRun = 4): string[][] {
  const sents = splitSentences(text);
  const runs: string[][] = [];
  let run: string[] = [];
  const isBlunt = (s: string) => wordCount(s) > 0 && wordCount(s) <= 8 && !CONNECTIVE_RE.test(s);
  const flush = () => {
    if (run.length >= minRun) {
      const lens = run.map(wordCount);
      // Monotony gate: only a near-uniform run is the AI tell. A run with real
      // length variation (max−min > 2) is expressive fragmentation — keep it.
      if (Math.max(...lens) - Math.min(...lens) <= 2) runs.push([...run]);
    }
    run = [];
  };
  for (const s of sents) {
    if (isBlunt(s)) run.push(s);
    else flush();
  }
  flush();
  return runs;
}

// ---- em-dash cap ----------------------------------------------------------
//
// The SKILL guides the model to ~1 em dash per 500 words. This DETECTOR is the
// CI backstop, so it's deliberately more lenient than the prose guideline — it
// should fail only on EGREGIOUS overuse (the em-dash-salad AI tell), not a
// second dash in a short, otherwise-human post. We allow ~1 per 200 words
// (min 2), so a 280-word post with 2 dashes passes but a post peppered with
// them fails. Counts real em dashes (—), not hyphens.

export function countEmDashes(text: string): number {
  return (text.match(/—/g) ?? []).length;
}

export function exceedsEmDashCap(text: string): boolean {
  const words = wordCount(text);
  const allowed = Math.max(2, Math.ceil(words / 200));
  return countEmDashes(text) > allowed;
}

// ---- banned vocabulary ----------------------------------------------------
//
// A tight, high-confidence subset of the skill's banned list — the words that
// are near-never correct in a human LinkedIn post. (The full list lives in the
// skill; this is the deterministic CI guard, kept conservative to avoid flagging
// a legitimate use.)

export const BANNED_WORDS = [
  "delve",
  "delves",
  "delving",
  "tapestry",
  "leverage", // as a verb; we accept the false-positive risk on "leverage ratio" — rare in posts
  "utilize",
  "seamless",
  "seamlessly",
  "transformative",
  "game-changer",
  "game-changing",
  "groundbreaking",
  "cutting-edge",
  "supercharge",
  "elevate your",
  "unlock the power",
  "pain points",
  "move the needle",
  "synergy",
  "synergies",
  "in today's",
  "it's worth noting",
  "let's dive in",
  "let's dive deeper",
  "at the end of the day",
  // Fancy/uncommon words a plain-language (≈5th-6th grade) post should replace
  // with the everyday equivalent. Kept to high-confidence offenders that are
  // near-never the right word AND are safe as a substring match (no common word
  // contains them). Deliberately NOT including "pool"/"pooling" — those collide
  // with legitimate uses (carpooling, connection pooling), so the prompt rule
  // handles them instead of this deterministic guard.
  "myriad",
  "plethora",
  "commence",
  "facilitate",
  // LinkedIn-slop closers observed shipping in a live draft (output-quality
  // audit): the judge flagged them as motivational filler while this detector
  // stayed silent. Safe substring matches — near-never legitimate in a post.
  "it's that simple",
  "let that sink in",
  "read that again",
  "the results speak for themselves",
  "that's the whole point",
];

export function findBannedWords(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_WORDS.filter((w) => lower.includes(w));
}

// ---- dismissive-negation fragment -----------------------------------------
//
// The "No theory. The actual..." / "No fluff." / "Not another listicle." pivot:
// a clipped negation fragment used as manufactured hype. The tell is a SHORT
// standalone fragment that negates a strawman with no verb — "No theory.",
// "No fluff.", "No BS.", "No gatekeeping." — or a "Not another X." opener.
//
// Conservative so we don't flag real sentences: we require either
//   • "No <1-3 short words>." with NO verb (so "No one knows what works." and
//     "No, I disagree." — which have verbs/clauses — are NOT flagged), or
//   • "Not another <…>." / "Not just <…>." as a sentence opener.

const NEGATION_VERB_RE =
  /\b(is|are|was|were|am|be|been|being|do|does|did|has|have|had|knows?|works?|matters?|means?|gets?|makes?|comes?|goes?|wants?|needs?|will|would|can|could|should)\b/i;

export function findDismissiveNegation(text: string): string[] {
  const hits: string[] = [];
  for (const s of splitSentences(text)) {
    const t = s.trim();
    // "No <up to 3 words>." with no verb → dismissive fragment.
    const noFrag = /^No\s+([A-Za-z][\w'-]*(?:\s+[\w'-]+){0,2})[.!]?$/.exec(t);
    if (noFrag && !NEGATION_VERB_RE.test(noFrag[1]) && wordCount(t) <= 4) {
      // Exclude "No one" / "No idea" style which read as normal speech.
      if (!/^No\s+(one|idea|way|thanks|problem|worries|comment)\b/i.test(t)) {
        hits.push(t);
        continue;
      }
    }
    // "Not another X." / "Not just X." opener.
    if (/^Not\s+(another|just)\b/i.test(t) && wordCount(t) <= 8) {
      hits.push(t);
    }
  }
  return hits;
}

// ---- repeated openers -----------------------------------------------------
//
// Three consecutive sentences in one paragraph starting with the same word.
// Most function words are excluded, but You/Your are intentionally checked:
// "You post. You write. You wonder." and "Your offer. Your price. Your
// product." are now common direct-address AI rhythms.

const OPENER_STOPWORDS = new Set([
  "the", "a", "an", "and", "but", "so", "or", "if", "in", "on", "it",
  "its", "this", "that", "these", "those", "we", "i", "he", "she",
  "they", "to", "of", "for", "with", "as", "at", "by", "my", "our",
  "their", "his", "her",
]);

export function findRepeatedOpeners(text: string): string[] {
  const hits: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const sentences = splitSentences(paragraph);
    const openerOf = (sentence: string) =>
      sentence.match(/^["'“”(\[]*([A-Za-z][\w'’-]*)/)?.[1]?.toLowerCase();
    let run = 1;
    for (let index = 1; index < sentences.length; index += 1) {
      const previous = openerOf(sentences[index - 1]);
      const current = openerOf(sentences[index]);
      if (current && current === previous && !OPENER_STOPWORDS.has(current)) {
        run += 1;
        if (run === 3) {
          hits.push(sentences.slice(index - 2, index + 1).join(" "));
        }
      } else {
        run = 1;
      }
    }
  }
  return hits;
}

// ---- negative parallelism -------------------------------------------------
//
// A three-beat negative list such as "Not likes, not impressions, not follower
// count." manufactures contrast instead of stating the positive claim.

export function findNegativeParallelism(text: string): string[] {
  const hits: string[] = [];
  const pattern =
    /(?:^|[.!?]\s|\n)((?:not|no)\s+[^,.!?\n]{1,48},\s*(?:not|no)\s+[^,.!?\n]{1,48},\s*(?:not|no|just)\s+[^.!?\n]{1,64})(?=[.!?]|$)/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    hits.push(match[1].trim());
  }
  return hits;
}

// ---- aggregate ------------------------------------------------------------
//
// Run every structural detector and return a flat list of violations. Empty =
// the draft is structurally clean. The live suite asserts this is empty.

export type Violation = { rule: string; detail: string };

export function structuralViolations(text: string): Violation[] {
  const v: Violation[] = [];
  for (const h of findRuleOfThree(text)) {
    v.push({ rule: "rule-of-three", detail: `${h.kind}: "${h.text}"` });
  }
  for (const run of findUniformLengthRun(text)) {
    v.push({
      rule: "uniform-sentence-length",
      detail: `${run.length} consecutive similar-length sentences`,
    });
  }
  for (const run of findParataxisRun(text)) {
    v.push({ rule: "parataxis", detail: `${run.length} chained blunt sentences` });
  }
  if (exceedsEmDashCap(text)) {
    v.push({ rule: "em-dash-cap", detail: `${countEmDashes(text)} em dashes` });
  }
  for (const w of findBannedWords(text)) {
    v.push({ rule: "banned-word", detail: w });
  }
  for (const f of findDismissiveNegation(text)) {
    v.push({ rule: "dismissive-negation", detail: `"${f}"` });
  }
  for (const run of findRepeatedOpeners(text)) {
    v.push({ rule: "repeated-opener", detail: `"${run}"` });
  }
  for (const run of findNegativeParallelism(text)) {
    v.push({ rule: "negative-parallelism", detail: `"${run}"` });
  }
  return v;
}

// The HEADLINE structural tells — the patterns a user actually flagged and the
// skill most needs to enforce. The LIVE eval gates on these (the model is
// non-deterministic, and noisier signals like uniform-length / parataxis would
// flake a live run); the full structuralViolations + unit tests remain the
// precise guard.
export function headlineViolations(text: string): Violation[] {
  return structuralViolations(text).filter(
    (v) =>
      v.rule === "rule-of-three" ||
      v.rule === "dismissive-negation" ||
      v.rule === "repeated-opener" ||
      v.rule === "negative-parallelism",
  );
}
