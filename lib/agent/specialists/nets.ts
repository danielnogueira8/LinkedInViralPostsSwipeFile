// Draft-body anti-slop nets — the deterministic, code-side guarantees that
// clean up or gate a generated post body regardless of which model produced it.
//
// These are PURE functions with no dependency on the agent turn execution
// layer. They were moved here (verbatim) out of the legacy run.ts loop so BOTH
// generation paths — the interactive chat turn and the modeled-batch path —
// import ONE copy instead of each worker reaching into the 3000-line run.ts
// module for them.
//
// The upcoming AI-Tell Editor (a later PR) is the natural next resident of this
// module.

// Detect a corrupted render_post/render_hook body so it never becomes a card.
//
// Root cause (investigated): the MODEL occasionally emits a garbled body inside
// an otherwise well-formed render_post call — JSON/fence control characters
// fused into the prose (the observed "...spec sheet.}}ermalink Long..."), often
// with the post cut off. The old gate only checked "non-empty", so the garbage
// rendered as a card; the model then self-corrected with a SECOND render_post,
// producing two cards (one broken, one good). Rejecting the corrupted one lets
// the self-correction's clean draft be the only card.
//
// DELIBERATELY NARROW + high-precision — false-positives drop a legitimate
// draft, so we target only signatures that are essentially never valid post
// prose, NOT "any post containing braces or backticks" (a post can legitimately
// discuss code or templating). Returns a short reason string when corrupted,
// or null when the body looks clean.
export function looksCorruptedDraft(body: string): string | null {
  // 1) A leaked artifact code-fence header: ```post / ```hook / ```cite inside
  //    the body. The model is told never to emit these; when one leaks into a
  //    render_* body it's the legacy-fence path bleeding through, not real prose.
  if (/```(?:post|hook|cite)\b/i.test(body)) {
    return "leaked code-fence marker";
  }
  // 2) The "}}ermalink"-class signature: two-or-more closing braces immediately
  //    fused to word characters with no space (e.g. "}}ermalink", "}}body").
  //    That's JSON closing-brace structure welded into prose — never legitimate
  //    writing. We require the braces to ABUT letters (no space) so a post that
  //    legitimately writes "}}" (e.g. a code snippet on its own line) with
  //    surrounding whitespace doesn't trip it. A BALANCED "{{word}}" template
  //    variable (e.g. "{{company}}'s" or "{{name}}s") is excluded even though
  //    its closing "}}" also abuts a letter — that's legitimate templating
  //    syntax some creators write in their own posts, not corrupted JSON.
  const balancedTemplateVariable = /\{\{\w+\}\}[A-Za-z]/;
  if (
    /\}{2,}[A-Za-z]/.test(body) &&
    !balancedTemplateVariable.test(body)
  ) {
    return "JSON brace fragment fused into text";
  }
  // 3) A stray JSON key fragment from the tool-args envelope leaking into prose:
  //    a quoted key like "permalink": / "body": / "postId": sitting inside the
  //    body. Real posts don't contain JSON key-value syntax. "title" is
  //    deliberately excluded from this alternation — unlike permalink/body/
  //    postId (internal-only field names that never occur in legitimate
  //    prose), "title" is an ordinary English word that a post can
  //    legitimately quote (e.g. discussing a job "title": field, or a
  //    template's own placeholder syntax) without being corrupted output.
  if (/"(?:permalink|body|postId)"\s*:/.test(body)) {
    return "JSON key fragment in body";
  }
  // 4) Hallucinated tool-call XML leaked into the body: <tool_call…>, <invoke
  //    name="…">, <parameter name="…">, <turn_state>. GLM occasionally emits
  //    these when it gets confused about the transport format (observed after
  //    a modeled-batch chat's follow-up turn — the panel got a card whose body was
  //    pure XML garbage that then rendered as an unreadable card). Never legit
  //    prose. See PR context: batch-chat followup + invisible-card fix.
  if (
    /<tool_call\b/i.test(body) ||
    /<invoke\s+name\s*=/i.test(body) ||
    /<parameter\s+name\s*=/i.test(body) ||
    /<turn_state\b/i.test(body)
  ) {
    return "tool-call XML leaked into body";
  }
  // 5) A pseudo tool call emitted AS the body: [search_news(query="…")] or a
  //    bare search_news(…) opener. A tool-less writer that "knows" it needs a
  //    tool it doesn't have sometimes simulates the call in-band instead of
  //    writing the post (observed in prod: the entire delivered draft body was
  //    '[search_news(query="AI generated content LinkedIn")]', packaged as a
  //    Post card). Real post prose never OPENS with function-call syntax, and
  //    the known-tool-name requirement keeps bracketed prose like
  //    "[read: the full story] …" clean.
  if (
    /^\s*\[?\s*(?:search_news|search_web|search_viral_posts|inspect_attachments|draft_post|render_post|render_hook|run_tool)\s*\(/i.test(
      body,
    )
  ) {
    return "simulated tool call emitted as draft body";
  }
  return null;
}

// Detect a writer response that is a REFUSAL or a clarifying question instead
// of the requested post — the "I can't run a live search_news call from here…
// here are two honest paths forward… tell me which one you want" class of
// output. The direct_writer route's validate hook only checks for non-empty
// text and the finalizer's gates have no refusal detection (the source-fidelity
// verdict is telemetry-only by design), so without this net that prose was
// packaged as a Post artifact under "Your draft is ready." — a conversational
// reply rendered as a draft card. When this fires, the caller delivers the text
// as a chat message with terminalReason "ask" instead of an artifact.
//
// DELIBERATELY high-precision, same posture as looksCorruptedDraft: a false
// positive swallows a legitimate post, so the net requires at least TWO
// independent signals — or ONE very strong one (the body OPENING with a
// first-person incapability statement about a task capability, which real post
// prose essentially never does). Consequences of that posture:
//   • First-person incapability is only counted when it's about a CAPABILITY
//     (run/access/search/verify/…), so a genuine opener like "I can't believe
//     it's been ten years" or "I cannot wait to share this" never trips it.
//   • A post that merely CONTAINS a question ("Can you explain your job?") or
//     ends on one ("What would you do?") scores at most one signal and passes.
//   • Meta-offer vocabulary is bounded to decision-routing phrasing ("paths
//     forward", "here are two options") — a post that mentions "two options"
//     in passing is not a signal.
// Returns a short reason string when the body is a refusal/clarification, or
// null when it looks like genuine post prose. Pure + exported for unit tests.
export function looksLikeRefusalOrClarification(body: string): string | null {
  const text = body.trim();
  if (!text) return null;

  // Signal 1 — first-person incapability ABOUT A TASK CAPABILITY: "I can't run
  // a live search", "I'm unable to access", "I don't have access to". The
  // capability-verb window is what keeps "I can't believe…" / "I can't wait…"
  // (legitimate post openers) from matching.
  const incapability =
    /\bI(?:'m| am)? (?:can'?t|cannot|can not|unable to|not able to)\b[^.!?\n]{0,60}?\b(?:run|access|search|browse|call|fetch|verify|pull|retrieve|look up|open|visit|scrape|publish|connect|perform|conduct|complete|guarantee|confirm)\b/i.exec(
      text,
    ) ??
    /\bI (?:don'?t|do not) have (?:access|a way|the ability|the tools|the data)\b/i.exec(
      text,
    ) ??
    /\bI have no (?:way|access|ability) to\b/i.exec(text);

  // The very strong single signal: the incapability IS the opening sentence.
  // A real post never starts by telling the user what the writer cannot do; a
  // refusal almost always does. (Requiring the first SENTENCE, not just an
  // early position, keeps a one-line pleasantry like "Happy to help with this.
  // I'm unable to…" on the two-signal path instead of firing on one.)
  if (incapability) {
    const prefix = text.slice(0, incapability.index);
    if (!/[.!?]/.test(prefix)) {
      return "opens with first-person incapability";
    }
  }

  let signals = incapability ? 1 : 0;

  // Signal 2 — meta-offer instead of content: the writer presents OPTIONS for
  // the user to pick between rather than writing the post ("paths forward",
  // "here are two options"). Bounded to decision-routing phrasing so a post
  // that discusses options as subject matter doesn't match.
  if (
    /\b(?:paths?|ways?|routes?|options?) forward\b/i.test(text) ||
    /\bhere (?:are|'re) (?:two|three|a few|a couple of|several)\b/i.test(text)
  ) {
    signals += 1;
  }

  // Signal 3 — the decision is handed back to the user: "tell me which",
  // "let me know which one you want", "which do you prefer".
  if (
    /\b(?:tell me|let me know) which\b/i.test(text) ||
    /\bwhich (?:one|option|path|approach|way) do you (?:want|prefer|like)\b/i.test(
      text,
    ) ||
    /\bwhich do you (?:want|prefer)\b/i.test(text)
  ) {
    signals += 1;
  }

  // Signal 4 — an offer to proceed on confirmation: "want me to", "would you
  // like me to", "shall I".
  if (/\b(?:want me to|would you like me to|shall I)\b/i.test(text)) {
    signals += 1;
  }

  // Signal 5 — the body ENDS on a user-directed question (a clarifying
  // question's signature). Only the final sentence is inspected, and it must
  // address the user, so a mid-post rhetorical question never counts.
  if (/\?\s*$/.test(text)) {
    const lastSentence = text.split(/(?<=[.!?])\s+/).pop() ?? "";
    if (/\b(?:you|your|which|prefer|want|should I|sound)\b/i.test(lastSentence)) {
      signals += 1;
    }
  }

  return signals >= 2 ? "refusal or clarifying question, not post prose" : null;
}

// Normalize a draft body into a dedupe key: lowercase, collapse all runs of
// whitespace to a single space, trim. So two render_post calls that differ only
// in trailing whitespace / line-break count / casing are recognized as the same
// draft and the duplicate is dropped (the "Draft 1 == Draft 2" bug). Genuinely
// different variations produce different keys and are kept.
export function normalizeDraftKey(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
}

function draftWords(body: string): string[] {
  return (
    normalizeDraftKey(body)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function setJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function bigrams(words: string[]): Set<string> {
  const result = new Set<string>();
  for (let index = 1; index < words.length; index += 1) {
    result.add(`${words[index - 1]}\u0000${words[index]}`);
  }
  return result;
}

/**
 * Conservative deterministic guard for multi-draft sets. Exact equality alone
 * lets a provider change one synonym and charge for a fake "variation". Long
 * drafts are near-duplicates when either their vocabulary or adjacent-word
 * progression is overwhelmingly the same; short snippets stay out of scope.
 */
export function areDraftsNearDuplicate(left: string, right: string): boolean {
  if (normalizeDraftKey(left) === normalizeDraftKey(right)) return true;
  const leftWords = draftWords(left);
  const rightWords = draftWords(right);
  if (Math.min(leftWords.length, rightWords.length) < 12) return false;
  const vocabularySimilarity = setJaccard(
    new Set(leftWords),
    new Set(rightWords),
  );
  const progressionSimilarity = setJaccard(
    bigrams(leftWords),
    bigrams(rightWords),
  );
  return vocabularySimilarity >= 0.88 || progressionSimilarity >= 0.74;
}

/**
 * Which axis tripped areDraftsNearDuplicate, for a human/model-facing repair
 * message — NOT a gating decision. "vocabulary" means the two drafts reuse
 * mostly the same words (a topic/angle problem); "progression" means the
 * word-to-word sequence overwhelmingly matches even if some words differ (a
 * structure/phrasing problem). Callers should already know the pair is a
 * near-duplicate (e.g. via areDraftsNearDuplicate) before asking why.
 */
export function duplicateReasonFor(
  left: string,
  right: string,
): "vocabulary" | "progression" {
  const leftWords = draftWords(left);
  const rightWords = draftWords(right);
  const vocabularySimilarity = setJaccard(
    new Set(leftWords),
    new Set(rightWords),
  );
  const progressionSimilarity = setJaccard(
    bigrams(leftWords),
    bigrams(rightWords),
  );
  return vocabularySimilarity >= progressionSimilarity
    ? "vocabulary"
    : "progression";
}

// Strip the em-dash AI tell from a draft body. The em dash (—) is THE signature
// "this was written by AI" mark on LinkedIn, and the prompt's "≤1 per 500 words"
// rule is non-deterministic — GLM still emits them. This is the deterministic
// net (same pattern as normalizePostBody / looksCorruptedDraft: a code-side
// guarantee, not a prompt request). We replace, never reject, so a good draft is
// never lost. Pure + exported for unit tests.
//   • " — " (spaced em dash, the usual clause break) → ", "
//   • a—b / a —b / a— b (tight em dash welding two words) → "a, b"
//   • an em dash hugging sentence punctuation (—. / .—) → drop the dash
//   • a leading "— " on a line → drop it
// En dashes (–) in number ranges ("3–5") are LEFT ALONE — they're not the tell.
export function stripEmDashes(body: string): string {
  return body
    // A dash at the start of a line (after the newline) → drop it, keep the line
    // break. MUST run before the punctuation rules, which would otherwise eat the
    // preceding newline as whitespace.
    .replace(/(^|\n)[ \t]*—[ \t]*/g, "$1")
    // Dash directly against terminal/clause punctuation → keep the punctuation
    // only (use [ \t] not \s so a newline is never consumed).
    .replace(/[ \t]*—[ \t]*([.!?,;:])/g, "$1")
    .replace(/([.!?,;:])[ \t]*—[ \t]*/g, "$1 ")
    // The common case: an em dash between two words/clauses → comma.
    .replace(/[ \t]*—[ \t]*/g, ", ")
    // Collapse any ", ," the replacements may have created.
    .replace(/,\s*,/g, ",")
    .replace(/[ \t]{2,}/g, " ");
}

// Detect the structural AI tells that trigger the bounded rewrite and the
// final delivery gate. Rephrasing these mechanically would risk changing the
// writer's meaning, so the model repair handles the edit; this conservative
// runtime mirror decides whether a candidate is clean enough to ship.
export function aiTellMetrics(body: string): string[] {
  const tells: string[] = [];
  // rule-of-three "a, b, c." cadence (1-4 short words each, no and/or) — the
  // headline AI tell. An Oxford "a, b, and c" is normal, so we exclude and/or.
  const three = body.match(
    /(?:^|[.!?]\s|:\s)([A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3},\s[A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3},\s[A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3})\s*(?=[.!?]|$)/m,
  );
  if (three && !/\b(and|or)\b/i.test(three[1])) tells.push("rule-of-three");
  // A maximal run of exactly three short sentences (1-4 words each) inside
  // ONE paragraph is the staccato-triad tell: "And it's over. No trophy. No
  // semifinal." Paragraph boundaries break the run, while two beats and a
  // deliberate four-beat rhythm remain allowed.
  const hasShortSentenceTriad = body.split(/\n\s*\n/).some((paragraph) => {
    const sentences = paragraph
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);
    let run = 0;
    for (let i = 0; i <= sentences.length; i++) {
      const words =
        i < sentences.length
          ? (sentences[i].match(/[A-Za-z0-9'’]+/g) ?? []).length
          : 0;
      if (words > 0 && words <= 4) {
        run++;
      } else {
        if (run === 3) return true;
        run = 0;
      }
    }
    return false;
  });
  if (hasShortSentenceTriad && !tells.includes("rule-of-three")) {
    tells.push("rule-of-three");
  }
  // Repeated-opener staccato — "Same three-sentence hook. Same fake setup.
  // Same generic list." Three or more consecutive sentences in one paragraph
  // opening with the SAME content word is the AI rhythm readers now pattern-
  // match on sight (the "same. same. same." tell). The shared opener must
  // normally be a content word. "You" and "Your" are the deliberate exception:
  // a three-beat direct-address run is a visible LinkedIn-AI cadence.
  const OPENER_STOPWORDS = new Set([
    "the", "a", "an", "and", "but", "so", "or", "if", "in", "on", "it",
    "its", "this", "that", "these", "those", "we", "i", "he", "she",
    "they", "to", "of", "for", "with", "as", "at", "by", "my",
    "our", "their", "his", "her",
  ]);
  const hasRepeatedOpenerRun = body.split(/\n\s*\n/).some((paragraph) => {
    const sentences = paragraph
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);
    const openerOf = (sentence: string) =>
      sentence.match(/^["'“”(\[]*([A-Za-z][\w'’-]*)/)?.[1]?.toLowerCase();
    let run = 1;
    for (let i = 1; i < sentences.length; i++) {
      const prev = openerOf(sentences[i - 1]);
      const curr = openerOf(sentences[i]);
      if (curr && curr === prev && !OPENER_STOPWORDS.has(curr)) {
        run += 1;
        if (run >= 3) return true;
      } else {
        run = 1;
      }
    }
    return false;
  });
  if (hasRepeatedOpenerRun) tells.push("repeated-opener");
  // Negative parallelism — "Not likes, not impressions, not follower count."
  // Keep this narrow: three comma-separated negative beats, with "just"
  // allowed only in the final reveal position.
  if (
    /(?:^|[.!?]\s|\n)(?:not|no)\s+[^,.!?\n]{1,48},\s*(?:not|no)\s+[^,.!?\n]{1,48},\s*(?:not|no|just)\s+[^.!?\n]{1,64}(?=[.!?]|$)/i.test(
      body,
    )
  ) {
    tells.push("negative-parallelism");
  }
  // "No fluff." / "Not another X." dismissive-negation pivot (exclude the
  // normal-speech "No one/idea/way…" openers).
  if (
    (/(?:^|[.!?]\s)No\s+[\w'’-]+[.!]?(?=\s|$)/.test(body) &&
      !/(?:^|[.!?]\s)No\s+(one|idea|way|thanks|problem|worries|comment)\b/i.test(body)) ||
    /(?:^|[.!?]\s)Not\s+(another|just)\b/i.test(body)
  ) {
    tells.push("dismissive-negation");
  }

  const patterns: Array<[string, RegExp]> = [
    ["contrast-pivot", /\b(?:it(?:'s| is)|this (?:is|isn't)|the point is) not\b[^.!?]{0,100}\b(?:it(?:'s| is)|but|the (?:real )?(?:point|story) is)\b/i],
    ["chatbot-artifact", /\b(?:I hope this helps|Great question|Certainly|Absolutely|feel free to reach out|let me know if you need anything else)\b/i],
    ["vague-attribution", /\b(?:experts believe|studies show|research suggests|industry leaders agree|analysts agree|independent testing confirms)\b/i],
    ["formulaic-opener", /^(?:In today'?s\b|In an era where\b|In the rapidly evolving\b|Imagine a world where\b|Picture a future (?:where|in which)\b|Let'?s (?:explore|examine|take a look|break this down|dive))/i],
    ["infomercial-hook", /(?:^|[.!?]\s)(?:The catch|The kicker|The best part|Plot twist|The result)\s*[?:]/i],
    ["generic-closer", /\b(?:the future looks bright|only time will tell|one thing is certain|as we move forward|that(?:'|’)s the whole point)\b/i],
    ["hedge-stack", /\b(?:could potentially|may eventually|might ultimately|could possibly|may potentially)\b/i],
    ["significance-inflation", /\b(?:watershed moment|mark(?:s|ing)? a pivotal moment|defining (?:trend|narrative|chapter)|most important narratives?)\b/i],
    ["model-disclaimer", /\b(?:as of my last (?:update|knowledge cutoff)|I (?:do not|don't) have access to real-time data|specific details are limited based on available information)\b/i],
    ["unfilled-placeholder", /(?:\[(?:Your|Insert|Add|Enter|Describe|Specify|Choose)[^\]]+\]|\b\d{4}-XX-XX\b)/i],
    ["citation-markup-leak", /(?:cite(?:turn)?\d+(?:search|news|view)\d+|contentReference\[oaicite:\d+\]|oai_citation|\[attached_file:\d+\]|grok_card)/i],
    // Below: patterns from the "humanizer" tell taxonomy that the set above
    // didn't already cover. Each is kept TIGHT to a distinctive phrase family so
    // it doesn't fire on normal LinkedIn copy — the same conservative posture as
    // rule-of-three (excludes and/or) and dismissive-negation (excludes normal
    // "No one/way"). Deliberately NOT added: boldface, emoji, title-case, curly
    // quotes (legitimate + useful on LinkedIn), and passive/copula/synonym-
    // cycling (too subtle for a regex — would misfire on good posts).

    // #7 AI vocabulary — the giveaway connective/filler words. Bounded to the
    // ones that are almost never natural in a founder's LinkedIn voice. "Delve",
    // "testament to", "at its core", "in today's fast-paced", "navigate the
    // complexities", "a game changer", "the landscape of".
    ["ai-vocabulary", /\b(?:delve into|delving into|elucidat(?:e|es|ed|ing)|kaleidoscop(?:e|ic)|unyielding|a testament to|at its core|in today'?s (?:fast-paced|digital|modern|ever-changing)|navigat(?:e|ing) the (?:complexit|landscape|nuance)|the (?:ever-evolving|ever-changing) landscape|underscor(?:e|es|ing) the importance|it'?s worth noting that|when it comes to)\b/i],
    // #23 filler phrases — wordy connectives a human tightens by reflex.
    ["filler-phrase", /\b(?:in order to\b|due to the fact that|for the (?:simple )?reason that|needless to say|it goes without saying|at the end of the day|when all is said and done)\b/i],
    // #27 persuasive authority tropes — the "trust me, here's the real truth"
    // setup that adds nothing. ("At its core" is in ai-vocabulary; here it's the
    // truth/mistake framings.)
    ["authority-trope", /(?:^|[.!?]\s)(?:The (?:hard |simple |uncomfortable )?truth is\b|Make no mistake\b|Let'?s be (?:honest|real|clear)\b|Here'?s the (?:hard )?truth\b)/i],
    // #28 signposting announcements — "listen up, content incoming" preambles
    // that should just be cut. Bounded to the classic set so a real sentence
    // starting with "Here's" (fine) isn't grabbed.
    ["signposting", /(?:^|[.!?]\s|\n)(?:Let'?s dive (?:in|into)|Buckle up|Here'?s what you need to know|Here'?s the (?:thing|deal|kicker)\b|Here'?s what I mean\b|Spoiler(?: alert)?\b|Without further ado)/i],
    // #31 manufactured staccato drama — a RUN of ultra-short "No X. No Y."
    // fragments each leading with the same negation family ("No prior. No
    // nostalgia.", "Just ship. Just post."). The tell is two-in-a-row of these
    // very short (<=16 char) fragments; a lone "No excuses." isn't grabbed here
    // (it needs a second consecutive one), and a natural mid-sentence "just"
    // ("I just want one thing") never matches because it's not fragment-initial.
    ["staccato-negation", /(?:^|[.!?]\s)(?:No|Not|Just)\s+[\w'’-]{1,15}[.!]\s+(?:No|Not|Just)\s+[\w'’-]{1,15}[.!]/],
    // #33 conversational rhetorical openers — the fake-candid "Honestly?" setup
    // at the very start of the post (or a paragraph), which reads as a chatbot
    // tic. Bounded to the opener position + the classic phrases.
    ["rhetorical-opener", /(?:^|\n)\s*(?:Honestly[,?]|Real talk[,.:]?|Truth be told[,.]?|Let'?s face it[,.]?|Look[,.]|Here'?s the thing[,.:])/i],
    // High-signal no-ai-slop patterns: promotional setups that delay a claim
    // instead of making it. Kept narrow because these reach the repair pass.
    ["faux-insight-setup", /(?:^|[.!?]\s)(?:This is the part (?:most people|everyone) (?:skip|miss)|What (?:most people|everyone) (?:get wrong|miss)(?: is|:)|Here'?s what nobody tells you|The part everyone misses)\b/i],
    ["colon-reveal", /(?:^|[.!?]\s|\n)(?:The (?:detail|thing|part) that (?:makes it work|matters)|The (?:best|real) part|The (?:real|big|actual) (?:shift|difference|lesson|secret|reason|trick))\s*:\s*[a-z]/i],
    ["rhetorical-setup", /(?:^|[.!?]\s)(?:What if I told you\b|Think about it\s*:)/i],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(body)) tells.push(name);
  }

  const hashtags = body.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length >= 6) tells.push("hashtag-stuffing");
  return tells;
}

// Quality gate for the optional "why I wrote it this way" one-liner the writer
// attaches to a draft (meta.rationale). The rationale is a BONUS: it makes the
// app feel like a collaborator that reasoned about a real choice ("Opened on
// the failure — vulnerability out-earns wins in founder-LinkedIn"), NOT a
// vending machine. But a GENERIC rationale ("I used an engaging tone to hook
// your audience") is worse than none — it's the exact AI-slop we strip from
// bodies, relocated into a caption. So a rationale that trips this net is
// DROPPED (the card renders as it does today), never surfaced and never used
// to reject the draft itself. This is a precision-over-recall filter: it should
// only fire on rationales that are unmistakably empty filler, not on borderline
// ones (a false negative just ships a mediocre note; a false positive silently
// eats a good one). Returns a reason tag when the rationale is too generic to
// show, or null when it's specific enough to keep.
export function rationaleTooGeneric(raw: string): string | null {
  const text = raw.trim();
  // Too short to say anything specific, or suspiciously long (a rationale is
  // one line, not a paragraph — a long one is usually the model dumping the
  // post's thesis or narrating, not explaining a craft choice).
  if (text.length < 15) return "too-short";
  if (text.length > 240) return "too-long";

  const lower = text.toLowerCase();

  // Empty-praise vocabulary: adjectives that describe the OUTPUT as good
  // without naming a concrete move. "Engaging", "compelling", "powerful",
  // "punchy", "attention-grabbing" etc. paired with generic nouns (hook, tone,
  // opening, structure, CTA) is the signature of a content-free rationale.
  const emptyPraise: RegExp[] = [
    /\b(?:engaging|compelling|powerful|punchy|strong|attention[- ]?grabbing|scroll[- ]?stopping|impactful|effective|captivating|resonant)\s+(?:hook|opener|opening|tone|voice|structure|cta|call to action|narrative|story|angle|framing|intro|line|copy|post)\b/,
    // "to hook/engage/resonate with your audience" — the payoff clause that
    // restates the obvious goal of every post instead of a specific reason.
    /\bto\s+(?:hook|engage|grab|captivate|resonate with|connect with|draw in|speak to)\s+(?:your|the)\s+(?:audience|reader|readers|ideal client)/,
    // "designed/crafted/written (it) to maximize engagement" and cousins. The
    // optional "it"/"this" object covers "structured it to maximize reach".
    /\b(?:designed|crafted|wrote|written|structured|built|tailored|optimi[sz]ed)\s+(?:it|this|the post)?\s*(?:to|for)\s+(?:maximi[sz]e|drive|boost|increase|spark)?\s*(?:engagement|reach|impact|virality|clicks|reactions)/,
    // Bare "kept it conversational/authentic/relatable" with nothing else — the
    // whole rationale is a single generic style adjective and nothing concrete.
    /^(?:i\s+)?(?:kept it|made it|wrote it)\s+(?:conversational|authentic|relatable|genuine|human|natural|approachable|professional)\.?$/,
  ];
  if (emptyPraise.some((re) => re.test(lower))) return "empty-praise";

  // Reuse the body-level tell library: a rationale carrying chatbot artifacts
  // ("great question", "I hope this helps") or AI-vocabulary ("delve",
  // "at its core") is filler by the same standard we apply to the post.
  const bodyTells = aiTellMetrics(text).filter(
    (t) => t === "chatbot-artifact" || t === "ai-vocabulary" || t === "filler-phrase",
  );
  if (bodyTells.length > 0) return bodyTells[0];

  return null;
}
