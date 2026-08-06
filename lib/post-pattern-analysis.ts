import { HOOK_PATTERNS, type HookPattern } from "@/lib/hooks";
import { computeStructureSkeleton } from "@/lib/post-structure-skeleton";
import { computeMechanicsFingerprint } from "@/lib/voice-mechanics";

// ---------------------------------------------------------------------------
// What a set of posts has in common.
//
// search_viral_posts answers "which posts did well". This answers "what do
// they DO" — the hook move they open with, how they are shaped on the page,
// how long they run. That is the step a generic model cannot take on its own,
// because it requires the corpus.
//
// DETERMINISTIC BY CONSTRUCTION. Every number here is counted or matched, not
// judged by a model. Two reasons: an info layer that costs us tokens per call
// cannot be metered cheaply, and an analysis that changes between identical
// calls is not analysis. It also means this can run over 50 posts in
// milliseconds inside a tool call.
//
// Structure and mechanics reuse the modules the writer already uses
// (computeStructureSkeleton, computeMechanicsFingerprint), so "what the corpus
// does" is measured on the same axes the drafting side is graded on. Only hook
// classification is new — HOOK_PATTERNS existed as a taxonomy, but nothing
// assigned it without an LLM.
// ---------------------------------------------------------------------------

export type AnalyzablePost = {
  id: string;
  body: string;
  /** Optional: lets the caller weight patterns by how the post performed. */
  engagement?: number | null;
};

/**
 * Hook classification.
 *
 * Ordered most-specific first and evaluated in order: a hook can satisfy
 * several of these (a question CONTAINING a statistic is both), and a stable,
 * documented precedence beats an arbitrary object-key order that could shift
 * under a refactor. `story_setup` and `direct_callout` sit last because they
 * are the broadest and would otherwise swallow more informative matches.
 */
const HOOK_RULES: ReadonlyArray<{
  pattern: HookPattern;
  test: (hook: string) => boolean;
}> = [
  {
    // "3 lessons", "7 things I learned" — a counted promise.
    pattern: "numbered_promise",
    test: (h) =>
      /^\s*\d+\s+\w/.test(h) ||
      /\b\d+\s+(?:lessons?|things?|ways?|steps?|tips?|reasons?|mistakes?|rules?|habits?|questions?|ideas?|examples?|frameworks?)\b/i.test(
        h,
      ),
  },
  {
    // A concrete figure doing the work: "$40k", "92% of founders".
    pattern: "stat_shock",
    test: (h) =>
      /[$£€]\s?\d/.test(h) ||
      /\b\d+(?:\.\d+)?\s?%/.test(h) ||
      /\b\d[\d,.]*\s?(?:k|m|bn|billion|million|thousand)\b/i.test(h),
  },
  {
    pattern: "contrarian",
    test: (h) =>
      /\b(?:unpopular opinion|hot take|nobody (?:is )?talking about|everyone (?:is )?wrong|myth|overrated|underrated|the truth about|contrary to)\b/i.test(
        h,
      ) ||
      // Imperative "Stop X" / "Don't X" is the contrarian move only when it
      // OPENS the hook. Anchored, because an unanchored \bdon'?t\b matched any
      // hook containing the word — "Confession: I don't read the docs" is a
      // confession, not a contrarian take.
      /^\s*(?:stop|don'?t|never)\b/i.test(h) ||
      /\bis (?:not|never)\b/i.test(h),
  },
  {
    pattern: "personal_failure",
    test: (h) =>
      /\bi (?:lost|failed|screwed|messed|blew|wasted|ruined|got (?:fired|rejected|dumped))\b/i.test(
        h,
      ) || /\b(?:biggest|worst) mistake\b/i.test(h),
  },
  {
    pattern: "confession",
    test: (h) =>
      /\b(?:i(?:'| a)?m going to be honest|confession|i never told|i'?ve never (?:said|admitted)|admit(?:ting)?|to be honest|nobody knows this)\b/i.test(
        h,
      ),
  },
  {
    pattern: "authority_drop",
    test: (h) =>
      /\b(?:after|in) \d+\+? (?:years?|months?)\b/i.test(h) ||
      /\b(?:i(?:'ve| have)) (?:built|scaled|sold|coached|worked with|helped|hired|reviewed|managed)\b/i.test(
        h,
      ),
  },
  {
    pattern: "curiosity_gap",
    test: (h) =>
      /\b(?:here'?s (?:what|why|how)|this is (?:what|why|how)|what (?:happened|nobody)|the reason|turns out|and then)\b/i.test(
        h,
      ),
  },
  {
    // Checked after the specific patterns so a numbered or stat-led question
    // reports the sharper classification.
    pattern: "question",
    test: (h) => h.trimEnd().endsWith("?"),
  },
  {
    pattern: "direct_callout",
    test: (h) =>
      /^\s*(?:if you|you(?:'re| are)|founders|marketers|recruiters|developers|to (?:every|all|any)\b)/i.test(
        h,
      ),
  },
  {
    // Broadest: a first-person scene opener. Last so it cannot pre-empt a
    // personal_failure or authority_drop that is also first-person.
    pattern: "story_setup",
    test: (h) => /^\s*(?:i|we|last|when|it was|back in|yesterday|a few)\b/i.test(h),
  },
];

/** The first line/sentence of a post — the part doing the hook's work. */
export function hookTextOf(body: string): string {
  const firstLine = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  // A hook can be one line or one sentence within a longer opening line; take
  // whichever is shorter so a wall-of-text opener doesn't classify on its tail.
  const firstSentence = firstLine.split(/(?<=[.!?])\s+/)[0] ?? firstLine;
  return (firstSentence.length < firstLine.length ? firstSentence : firstLine).trim();
}

/**
 * Classify a hook, or null when nothing matches.
 *
 * Null is deliberate and is NOT folded into a catch-all bucket: a post whose
 * opener matches no known move is a real signal (it may be a pattern worth
 * naming), and silently labelling it "story_setup" would both overstate that
 * pattern's frequency and hide the interesting case.
 */
export function classifyHook(body: string): HookPattern | null {
  const hook = hookTextOf(body);
  if (!hook) return null;
  for (const rule of HOOK_RULES) {
    if (rule.test(hook)) return rule.pattern;
  }
  return null;
}

export type HookPatternStat = {
  pattern: HookPattern | "unclassified";
  posts: number;
  share: number;
  /** Mean engagement of posts using it, when the caller supplied engagement. */
  avg_engagement: number | null;
  example_post_ids: string[];
};

const MAX_EXAMPLES = 3;

/**
 * Frequency of each hook move, richest first.
 *
 * Sorted by post count rather than by avg_engagement: with a handful of posts
 * per bucket, ranking on a mean puts a single lucky post at the top and reads
 * as "this hook works best", which the sample cannot support. The caller gets
 * both numbers and can decide.
 */
export function hookPatternStats(
  posts: readonly AnalyzablePost[],
): HookPatternStat[] {
  const buckets = new Map<string, { ids: string[]; engagements: number[] }>();
  for (const post of posts) {
    const key = classifyHook(post.body) ?? "unclassified";
    const bucket = buckets.get(key) ?? { ids: [], engagements: [] };
    bucket.ids.push(post.id);
    if (typeof post.engagement === "number") {
      bucket.engagements.push(post.engagement);
    }
    buckets.set(key, bucket);
  }
  const total = posts.length;
  return [...buckets.entries()]
    .map(([pattern, bucket]) => ({
      pattern: pattern as HookPattern | "unclassified",
      posts: bucket.ids.length,
      share: total > 0 ? bucket.ids.length / total : 0,
      avg_engagement: bucket.engagements.length
        ? bucket.engagements.reduce((a, b) => a + b, 0) / bucket.engagements.length
        : null,
      example_post_ids: bucket.ids.slice(0, MAX_EXAMPLES),
    }))
    .sort((a, b) => b.posts - a.posts || a.pattern.localeCompare(b.pattern));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export type StructureStats = {
  median_words: number;
  median_paragraphs: number;
  median_visual_lines: number;
  uses_list_rate: number;
  dominant_list_marker: string | null;
  post_script_rate: number;
  median_hook_chars: number;
};

/**
 * Shape of the set on the page.
 *
 * Medians, not means: post length is heavily skewed (one 900-word essay among
 * 20 short posts drags a mean far above anything actually typical), and the
 * question this answers is "how long is a post like these", not "what is the
 * arithmetic average".
 */
export function structureStats(posts: readonly AnalyzablePost[]): StructureStats {
  const skeletons = posts
    .map((post) => post.body?.trim())
    .filter((body): body is string => Boolean(body))
    .map((body) => computeStructureSkeleton(body));
  if (skeletons.length === 0) {
    return {
      median_words: 0,
      median_paragraphs: 0,
      median_visual_lines: 0,
      uses_list_rate: 0,
      dominant_list_marker: null,
      post_script_rate: 0,
      median_hook_chars: 0,
    };
  }
  const markerCounts = new Map<string, number>();
  for (const skeleton of skeletons) {
    if (skeleton.hasList && skeleton.listMarker) {
      const key = String(skeleton.listMarker);
      markerCounts.set(key, (markerCounts.get(key) ?? 0) + 1);
    }
  }
  const dominant = [...markerCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];
  return {
    median_words: median(skeletons.map((s) => s.totalWords)),
    median_paragraphs: median(skeletons.map((s) => s.paragraphCount)),
    median_visual_lines: median(skeletons.map((s) => s.visualLineCount)),
    uses_list_rate:
      skeletons.filter((s) => s.hasList).length / skeletons.length,
    dominant_list_marker: dominant ? dominant[0] : null,
    post_script_rate:
      skeletons.filter((s) => s.hasPostScript).length / skeletons.length,
    median_hook_chars: median(skeletons.map((s) => s.hookChars)),
  };
}

export type PostPatternAnalysis = {
  analyzed_posts: number;
  hook_patterns: HookPatternStat[];
  structure: StructureStats;
  mechanics: ReturnType<typeof computeMechanicsFingerprint>;
};

/**
 * The full deterministic read on a set of posts.
 *
 * Callers should treat a small `analyzed_posts` as weak evidence; the tool
 * surface says so explicitly rather than hiding it behind confident-looking
 * percentages.
 */
export function analyzePostPatterns(
  posts: readonly AnalyzablePost[],
): PostPatternAnalysis {
  const usable = posts.filter((post) => Boolean(post.body?.trim()));
  return {
    analyzed_posts: usable.length,
    hook_patterns: hookPatternStats(usable),
    structure: structureStats(usable),
    mechanics: computeMechanicsFingerprint(usable.map((post) => post.body)),
  };
}

export { HOOK_PATTERNS };
