// Draft-body anti-slop nets — the deterministic, code-side guarantees that
// clean up or gate a generated post body regardless of which model produced it.
//
// These are PURE functions with no dependency on the agent loop. They were
// moved here (verbatim) out of lib/agent/run.ts so BOTH generation paths — the
// interactive chat loop (run.ts) and the headless weekly-batch path
// (lib/batch/weekly.ts) — import ONE copy instead of the batch worker reaching
// into the 3000-line run.ts module for them. run.ts re-exports these so every
// existing importer keeps working unchanged; this move is behavior-identical.
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
  //    surrounding whitespace doesn't trip it.
  if (/\}{2,}[A-Za-z]/.test(body)) {
    return "JSON brace fragment fused into text";
  }
  // 3) A stray JSON key fragment from the tool-args envelope leaking into prose:
  //    a quoted key like "permalink": / "body": / "postId": sitting inside the
  //    body. Real posts don't contain JSON key-value syntax.
  if (/"(?:permalink|body|postId|title)"\s*:/.test(body)) {
    return "JSON key fragment in body";
  }
  // 4) Hallucinated tool-call XML leaked into the body: <tool_call…>, <invoke
  //    name="…">, <parameter name="…">, <turn_state>. GLM occasionally emits
  //    these when it gets confused about the transport format (observed after
  //    a batch chat's follow-up turn — the panel got a card whose body was
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
  return null;
}

// Normalize a draft body into a dedupe key: lowercase, collapse all runs of
// whitespace to a single space, trim. So two render_post calls that differ only
// in trailing whitespace / line-break count / casing are recognized as the same
// draft and the duplicate is dropped (the "Draft 1 == Draft 2" bug). Genuinely
// different variations produce different keys and are kept.
export function normalizeDraftKey(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
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

// Detect-and-LOG the structural AI tells we DON'T auto-rewrite (rewriting a
// staccato triad or a banned word means rephrasing — unsafe to do mechanically
// without mangling a deliberate line). So instead of editing, we emit a metric
// when a shipped draft trips one, giving observability ("how often does a draft
// go out with a rule-of-three?") without the rewrite risk. The precise detector
// library lives in evals/anti-slop-detectors.ts (and gates the live suite); this
// is a deliberately tiny, conservative lib-side mirror for the runtime log only.
export function aiTellMetrics(body: string): string[] {
  const tells: string[] = [];
  // rule-of-three "a, b, c." cadence (1-4 short words each, no and/or) — the
  // headline AI tell. An Oxford "a, b, and c" is normal, so we exclude and/or.
  const three = body.match(
    /(?:^|[.!?]\s|:\s)([A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3},\s[A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3},\s[A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3})\s*(?=[.!?]|$)/m,
  );
  if (three && !/\b(and|or)\b/i.test(three[1])) tells.push("rule-of-three");
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
    ["generic-closer", /\b(?:the future looks bright|only time will tell|one thing is certain|as we move forward)\b/i],
    ["hedge-stack", /\b(?:could potentially|may eventually|might ultimately|could possibly|may potentially)\b/i],
    ["significance-inflation", /\b(?:watershed moment|mark(?:s|ing)? a pivotal moment|defining (?:trend|narrative|chapter)|most important narratives?)\b/i],
    ["model-disclaimer", /\b(?:as of my last (?:update|knowledge cutoff)|I (?:do not|don't) have access to real-time data|specific details are limited based on available information)\b/i],
    ["unfilled-placeholder", /(?:\[(?:Your|Insert|Add|Enter|Describe|Specify|Choose)[^\]]+\]|\b\d{4}-XX-XX\b)/i],
    ["citation-markup-leak", /(?:cite(?:turn)?\d+(?:search|news|view)\d+|contentReference\[oaicite:\d+\]|oai_citation|\[attached_file:\d+\]|grok_card)/i],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(body)) tells.push(name);
  }

  const hashtags = body.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length >= 6) tells.push("hashtag-stuffing");
  return tells;
}
