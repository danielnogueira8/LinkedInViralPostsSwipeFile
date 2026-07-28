// Topic-term extraction + clustering for Workspace Learning topic signals.
//
// The topic descriptor in a draft's lineage is a real label ("Founder
// systems"), but most published posts have NO lineage row. The old fallback
// used the artifact title — the first 60 characters of the body, cut
// mid-word — so every post became its own singleton "topic" and the Topics
// card read as a list of truncated headlines ("Seen in 1 published post"
// everywhere). This module extracts short thematic terms from the post body
// (multiword content phrases + meaningful unigrams) and greedily clusters
// posts that share one, so the card shows real topics with real counts
// ("Booked calls — seen in 2 posts").
//
// Pure + exported for tests.

// Function words, auxiliaries, and high-frequency glue that must never edge
// (or alone form) a topic term. Interior stopwords inside a bigram are fine
// ("kill a sale"); edges are what keep labels readable.
const TOPIC_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "so", "or", "nor", "yet", "for",
  "of", "in", "on", "at", "by", "to", "from", "with", "without", "about",
  "into", "over", "under", "after", "before", "between", "through", "during",
  "as", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done", "doing", "have", "has", "had", "having",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers", "it", "its", "they", "them",
  "their", "theirs", "this", "that", "these", "those", "there", "here",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "if", "then", "than", "because", "while", "until", "unless", "though",
  "although", "since", "whether", "both", "either", "neither",
  "not", "no", "never", "ever", "just", "only", "also", "too", "very",
  "really", "quite", "rather", "pretty", "much", "many", "more", "most",
  "less", "least", "some", "any", "all", "every", "each", "few", "several",
  "own", "same", "other", "another", "such", "like", "even", "still",
  "again", "back", "out", "up", "down", "off", "away", "now", "today",
  "yesterday", "tomorrow", "ago", "later", "soon", "once", "twice",
  "one", "ones", "two", "three", "first", "second", "third", "last",
  "new", "old", "good", "bad", "worst", "better", "worse",
  "thing", "things", "something", "anything", "everything", "nothing",
  "everyone", "someone", "anyone", "nobody", "somebody", "anybody",
  "people", "person", "way", "ways", "lot", "lots", "kind", "sort",
  "year", "years", "month", "months", "week", "weeks", "day", "days",
  "time", "times", "today's", "get", "gets", "got", "getting", "make",
  "makes", "made", "making", "keep", "keeps", "kept", "let", "lets",
  "say", "says", "said", "saying", "tell", "tells", "told", "telling",
  "received", "zero", "fix", "fixes", "fixed", "fixing",
  "makes", "made", "making", "keep", "keeps", "kept", "let", "lets",
  "say", "says", "said", "saying", "tell", "tells", "told", "telling",
  "know", "knows", "knew", "knowing", "think", "thinks", "thought",
  "want", "wants", "wanted", "need", "needs", "needed", "use", "uses",
  "used", "using", "work", "works", "worked", "working", "take", "takes",
  "took", "give", "gives", "gave", "go", "goes", "went", "going", "come",
  "comes", "came", "see", "sees", "saw", "look", "looks", "looked",
  "stop", "stops", "stopped", "start", "starts", "started", "change",
  "changed", "changing", "write", "writes", "wrote", "writing", "written",
  "read", "reads", "reading", "post", "posts", "posting", "posted",
  "probably", "actually", "literally", "basically", "honestly", "exactly",
  "right", "wrong", "sure", "yes", "yeah", "ok", "okay", "hey", "hi",
  "etc", "vs", "via", "per", "re",
]);

export type TopicTerm = {
  /** Display label, e.g. "Booked calls" / "LinkedIn ghostwriter" / "AI". */
  label: string;
  /** Lowercased grouping key. */
  normalized: string;
  /** Extraction rank: multiword phrases outrank unigrams. */
  score: number;
};

type Token = { surface: string; lower: string; capitalized: boolean };

function tokenize(text: string): Token[] {
  return (text.match(/[A-Za-z][A-Za-z0-9'’-]*/g) ?? []).map((surface) => ({
    surface,
    lower: surface.toLowerCase(),
    capitalized: /^[A-Z]/.test(surface),
  }));
}

function isContentWord(token: Token): boolean {
  return !TOPIC_STOPWORDS.has(token.lower) && !/^\d+$/.test(token.lower);
}

function labelFor(words: Token[]): string {
  const joined = words.map((word) => word.surface).join(" ");
  // Capitalize a fully-lowercase label's first letter ("booked calls" →
  // "Booked calls"); preserve inner casing ("LinkedIn ghostwriter").
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Extract up to `limit` thematic term candidates from a post body, best
 * first. Multiword content phrases from the opening carry the topic
 * ("LinkedIn ghostwriter", "booked calls"); capitalized unigrams (AI,
 * ChatGPT, LinkedIn) and long content unigrams (ghostwriter, detector)
 * backfill when no phrase exists.
 */
export function extractTopicCandidates(
  body: string,
  limit = 4,
): TopicTerm[] {
  const opening = body
    .split(/\n\s*\n/)
    .slice(0, 2)
    .join(" ")
    .slice(0, 600);
  const tokens = tokenize(opening);
  const found = new Map<string, TopicTerm>();
  const add = (words: Token[], score: number) => {
    if (words.length === 0) return;
    const normalized = words.map((word) => word.surface).join(" ").toLowerCase();
    const existing = found.get(normalized);
    if (!existing || existing.score < score) {
      found.set(normalized, { label: labelFor(words), normalized, score });
    }
  };

  // N-grams (3 then 2) with content-word edges — interior stopwords allowed
  // ("kill a sale"), edges trimmed so labels never start/end on glue.
  // 3-grams led by an -ing verb read as fragments of a sentence, not topics
  // ("Hiring a LinkedIn…"), so they're skipped.
  for (const n of [3, 2] as const) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const window = tokens.slice(i, i + n);
      if (!isContentWord(window[0]!) || !isContentWord(window[n - 1]!)) {
        continue;
      }
      if (n === 3 && /ing$/i.test(window[0]!.surface)) continue;
      add(window, n + (window.some((word) => word.capitalized) ? 0.5 : 0));
    }
  }
  // Unigram fallback: capitalized terms (AI, ChatGPT, LinkedIn) or long
  // content words (ghostwriter, detector).
  for (const token of tokens) {
    if (!isContentWord(token)) continue;
    if (token.capitalized || token.lower.length >= 7) {
      add([token], 1);
    }
  }

  return [...found.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.label.length - left.label.length ||
        (left.normalized < right.normalized ? -1 : 1),
    )
    .slice(0, limit);
}

export type TopicCluster<T> = { label: string; normalized: string; members: T[] };

/**
 * Greedy topic clustering. Each item contributes candidate terms (its
 * lineage topic when it has one — a full-phrase term — else extracted
 * candidates). Terms rank by cluster value (covering ≥2 items), phrase-ness,
 * then coverage; each item joins the best-ranked term it belongs to. Items
 * no term covers keep their own best term as a singleton label — a truthful
 * "seen in 1 post", now with a readable name.
 */
export function clusterTopicTerms<T>(
  items: T[],
  termsFor: (item: T) => TopicTerm[],
): TopicCluster<T>[] {
  const index = new Map<string, { label: string; members: number[]; words: number }>();
  items.forEach((item, itemIndex) => {
    for (const term of termsFor(item)) {
      const entry = index.get(term.normalized) ?? {
        label: term.label,
        members: [],
        words: term.label.split(" ").length,
      };
      entry.members.push(itemIndex);
      index.set(term.normalized, entry);
    }
  });
  const ranked = [...index.entries()].sort((left, right) => {
    // Specific multiword phrases always outrank coverage alone — a unigram
    // appearing everywhere ("LinkedIn") is context, not a topic.
    const score = ([, entry]: [string, { members: number[]; words: number }]) =>
      (entry.words >= 2 ? 1000 : 0) +
      (entry.members.length >= 2 ? 100 : 0) +
      entry.members.length;
    return score(right) - score(left) || (left[0] < right[0] ? -1 : 1);
  });
  const assigned = new Set<number>();
  const clusters: TopicCluster<T>[] = [];
  for (const [normalized, entry] of ranked) {
    const fresh = entry.members.filter((member) => !assigned.has(member));
    if (fresh.length === 0) continue;
    for (const member of fresh) assigned.add(member);
    clusters.push({
      label: entry.label,
      normalized,
      members: fresh.map((member) => items[member]!),
    });
  }
  // Singletons for anything no term claimed (e.g. no candidates at all).
  items.forEach((item, itemIndex) => {
    if (assigned.has(itemIndex)) return;
    const best = termsFor(item)[0];
    clusters.push({
      label: best?.label ?? "Untitled topic",
      normalized: best?.normalized ?? `singleton-${itemIndex}`,
      members: [item],
    });
  });
  return clusters;
}
