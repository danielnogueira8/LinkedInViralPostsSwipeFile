// Agent "skills" — the Anthropic-Skills technique reimplemented for our GLM
// agent. Each skill is a focused block of expert instructions for one kind of
// task. A selector picks the relevant skill(s) from the user's latest message
// and the agent injects them as an extra context block (see run.ts), so the
// model gets task-specific expertise without bloating every prompt.
//
// Why inline (not separate .md files): Next.js only bundles statically-imported
// modules, so loose .md files can be missing from the serverless bundle, and a
// runtime fs read of them is fragile. Keeping the content here makes the skills
// the single source of truth and guarantees they ship. They're still plain
// markdown strings — edit them like docs.

export type Skill = {
  id: string;
  // Lowercased keywords/phrases in the user's message that activate this skill.
  triggers: string[];
  // The instruction block injected into the prompt when active.
  body: string;
};

const HOOKS: Skill = {
  id: "hooks",
  triggers: ["hook", "hooks", "opener", "openers", "first line", "opening line"],
  body: `# Writing scroll-stopping hooks
The hook is the first 1–2 lines — all that shows before LinkedIn's "…see more" cut (~210 chars). If it doesn't earn the click, nothing else matters.

Make it work:
- One sharp idea. Two ideas dilute it.
- Concrete over abstract — numbers, names, specifics beat generalities.
- Open a loop: state something that demands the next line to resolve it.
- Earned, not clickbait — the post must pay off the hook.

Strong patterns (structures, not templates to copy): contrarian ("Everyone says X. They're wrong."); result-first ("We 3x'd replies in 30 days. Here's how."); confession ("I almost killed our best account."); curiosity gap; listicle promise ("5 things I'd tell my younger self"); pattern interrupt (a short jarring line).

Avoid: throat-clearing ("I wanted to share…"), engagement-bait ("Agree?"), vague abstractions, corporate tone, hedging. When adapting a viral hook, keep its structure/tension, replace its specifics with the user's, and confirm it fits the ~210-char preview.

Don't let "punchy" become an AI tell: a staccato triad like "Not 5. Not 10. Two." reads as machine-written even though it feels snappy. Break the count — use two beats or four, not three. (See the global writing rules; the structural rules there are not optional for hooks.)`,
};

const LEAD_MAGNET: Skill = {
  id: "lead-magnet",
  triggers: [
    "lead magnet",
    "lead-magnet",
    "leadmagnet",
    "giveaway",
    "freebie",
    "free resource",
    "comment and i'll send",
    "dm magnet",
  ],
  body: `# Lead-magnet / giveaway posts
Goal: qualified inbound (comments/DMs), not vanity likes. If the user's voice profile has a lead_magnet_style block, it overrides the general voice here.

Structure that converts:
1. Hook — name the specific outcome or pain the resource solves.
2. Stakes/proof — why it matters now, or proof it works (a result, a number, a mini-story).
3. What they get — describe the resource concretely; bullet the contents if it's a set of assets.
4. The ask — ONE low-friction CTA, usually "comment <keyword>" (+ optionally follow so you can DM). Short, on-theme keyword.
5. Remove friction — "no link, just comment X" beats sending people off-platform.

Rules: one CTA only (two halve conversion); the resource must sound specific and finished, not "a guide"; match the keyword to the topic. Avoid burying the ask under a wall of text, over-hyping, or competing links.`,
};

const VOICE_MATCH: Skill = {
  id: "voice-match",
  triggers: [
    "in my voice",
    "my voice",
    "sound like me",
    "rewrite",
    "original post",
    "write a post",
    "draft a post",
    "mimic",
    "adapt",
  ],
  body: `# Matching the user's voice
Call get_voice first if you haven't this turn, then write to the profile, not to a generic "good post" template.

Match: tone (blunt vs warm, formal vs casual); sentence rhythm/cadence (short punchy vs long flowing, one-line paragraphs); signature moves (recurring phrases, openings, sign-offs — the fingerprint); their actual vocabulary; their do/don't list (honor literally).

Technique: mirror how a real post of theirs is built and reproduce that build with new content. When unsure, write plainer and more specific — that survives mismatch better than flowery writing. Read it back: "Would *they* actually post this sentence?" Cut what fails.

Avoid generic LinkedIn-isms they don't use ("let's dive in," "game-changer," excess emojis if they're sparse), flattening to neutral professional tone, and inventing facts about the user (use a clearly-marked placeholder instead). If no profile exists, say so and offer a neutral professional voice meanwhile.`,
};

const NAMEJACKING: Skill = {
  id: "namejacking",
  triggers: [
    "namejack",
    "name-jack",
    "namejacking",
    "ride someone's name",
    "borrow someone's audience",
  ],
  body: `# Namejacking (borrow a PERSON's attention)
Borrow the pre-built attention attached to a specific, recognizable person and redirect a slice toward the user's idea. The name is the door; the insight is the room. A name with no insight is just name-dropping and audiences punish it.

Structure (5 moves): 1) Anchor — open with the name (it stops the scroll). 2) Locate — state their position/take/achievement accurately, 1–2 lines. 3) Pivot — turn to the user's angle. 4) Deliver — the lesson/framework/insight the reader keeps. 5) Land — tie back to the reader + soft CTA.

Pick ONE lane: Agree & Extend ("X is right about Y — here's what people get wrong trying it"); Respectful Contrarian ("everyone copies X; it quietly fails for [segment] — do this instead" — highest engagement, must be fair); Decode ("I studied X's [thing] — here's the system underneath"); Apply/Translate ("X does this in [field] — steal it for [reader's field]").

Rules: add value, don't leech. NEVER fabricate quotes/stats/positions and attribute them to a real person — describe their position generally if unsure (fake words = trust + legal risk). Punch up or sideways, never down. Relevance over fame — the name your ICP cares about beats a bigger name they don't. Have a real point; worshipful "X is a genius 🙏" adds nothing.`,
};

const BRANDJACKING: Skill = {
  id: "brandjacking",
  triggers: [
    "brandjack",
    "brand-jack",
    "brandjacking",
    "teardown",
    "tear down",
    "steal their playbook",
    "steal the playbook",
  ],
  body: `# Brandjacking (borrow a BRAND/company's attention)
Borrow the recognition of a well-known brand/company/product and redirect it toward the user's idea via analysis. The brand is the door; the teardown is the room. This is REFERENCING a brand (teardowns, comparisons, "steal this"), NOT impersonation — never fake official accounts, misuse logos, or claim false partnerships.

Structure (5 moves): 1) Anchor — open with the brand. 2) Locate — what it does/did, accurately. 3) Pivot — the user's angle. 4) Deliver — what the reader can copy/avoid/understand. 5) Land — tie to the reader + soft CTA.

Pick ONE lane: Teardown ("I analyzed [Brand]'s onboarding — 3 they nail, 1 they botch"); Steal-this ("[Brand] spends millions on this — copy 80% free as a 2-person team"); Contrarian ("don't copy [Brand] — it backfires for [segment]"); Versus ("[A] vs [B] — who should copy which"); Commentary/Prediction ("why [Brand]'s move is smarter than it looks"); Underdog/Reframe ("you don't need their $X tool — here's the lean version").

Rules: be factual — don't invent a brand's metrics, decisions, or statements (speculation only when labeled as your read). Criticism must be fair and defensible — critique the work, not invented scandals (false claims = defamation). Pick brands the audience knows. Add genuine analysis, not a shoutout. Punch up or sideways.`,
};

const NEWSJACKING: Skill = {
  id: "newsjacking",
  triggers: [
    "newsjack",
    "news-jack",
    "newsjacking",
    "trending",
    "breaking",
    "my take on",
    "react to the news",
    "just launched",
    "just announced",
    "funding round",
    "acquisition",
    "layoffs",
  ],
  body: `# Newsjacking (borrow a TIMELY EVENT's attention)
Inject the user's expertise into a breaking story to capture the spike of attention and search demand it creates. Speed is the multiplier; the window closes fast and forced relevance backfires.

Run the decision filter BEFORE writing — proceed only if ALL four are yes: Relevant? (connects to their expertise without a stretch); Angle? (a real insight, not "wow big news"); Timely? (early enough to be fresh); Appropriate? NEVER newsjack tragedies, deaths, disasters, violence, or human suffering for promotion — that's the cardinal sin and permanently damages trust.

Structure (5 moves): 1) The news — what happened, briefly + accurately. 2) The pivot — bridge to the user's domain ("here's what this means for [audience]"). 3) The insight — the expert read: implication, hidden angle, what-to-do. 4) The takeaway — what the reader should think/do now. 5) Land — soft CTA or a question.

Speed tiers: real-time (hours) for big obvious stories — a sharp 4-line take beats a polished essay tomorrow; same-day for a considered angle; this-week for slower trends/reports.

Rules: relevance over reach (forced bridges get ratioed). Verify the news is real before posting — fast AND wrong is worse than late. Add expertise, not just emotion. Have an opinion held in good faith. Stay in your lane.`,
};

export const SKILLS: Skill[] = [
  HOOKS,
  LEAD_MAGNET,
  VOICE_MATCH,
  NAMEJACKING,
  BRANDJACKING,
  NEWSJACKING,
];

// ---------------------------------------------------------------------------
// GLOBAL writing skill — always on, every turn, every workspace.
//
// Unlike the triggered SKILLS above (selected by keyword), this is injected
// into EVERY agent turn because it applies to all writing the agent produces.
// It rides in the CACHEABLE system prefix (see run.ts), so on a warm turn the
// per-turn token cost is the cache-discounted rate, not full price.
//
// Source: the open-source "anti-ai-slop-writing" skill
// (github.com/jalaalrd/anti-ai-slop-writing, SKILL.md + references/banned-words.md),
// inlined here verbatim (the app can't fetch the repo's references/ file at
// runtime) and adapted for this product with ONE precedence rule: the user's
// own voice wins. If their real voice uses a "banned" word or a punchy
// short-sentence rhythm, KEEP it — these rules are the default for neutral
// drafting, not a filter that flattens every founder to the same de-slopped
// tone. The voice profile (get_voice) and the user's explicit instructions
// always override anything below.
export const GLOBAL_WRITING_SKILL = `# Write like a human, not like AI (always apply)

Everything you draft — posts, hooks, rewrites, captions, any prose — must avoid statistically detectable AI writing patterns. Apply these silently; never mention them.

PRECEDENCE — read carefully, this is where drafts go wrong:
- The STRUCTURAL rules below (no rule of three, no uniform sentence length, no parataxis, the em-dash cap) are NON-NEGOTIABLE. They are not stylistic preferences — they are the specific patterns that make text read as AI-generated, and they override the pull toward a "punchy" or "snappy" rhythm. A triad like "Not 5. Not 10. Two." or "Numbers, timeframes, names." is an AI tell, NOT the user's voice — never produce one for effect, no matter how punchy it feels. The user's voice does not include AI tells.
- The user's voice governs WORD CHOICE and TONE only. If their voice profile (get_voice) or an explicit instruction uses a word on the banned list, or a blunt/casual register, honor THAT — don't flatten a distinctive founder voice to a generic neutral tone. But matching their voice never means reproducing a structural AI tell.
- If you catch yourself writing three of anything in a row — three short fragments, three parallel sentences, three list items that didn't have to be three, three examples — STOP and change the count to two or four. This is the single most common way this draft fails.

## Banned vocabulary (replace with a concrete, specific alternative or restructure)
delve/delves/delving, tapestry, landscape (figurative), testament ("a testament to"), vibrant, pivotal, crucial, intricate/intricacies, meticulous/meticulously, bolster/bolstered, garner/garnered, underscore/underscores, interplay, multifaceted, nuanced (as filler), foster/fostering, leverage (as verb), utilize (say "use"), commence (say "start"), facilitate, encompass/encompassing, paramount, groundbreaking, cutting-edge, game-changing/game-changer, transformative, revolutionize, seamless/seamlessly, robust (outside engineering), comprehensive (describing your own output), endeavor, aforementioned, harnessing, spearheading, navigating (figurative), showcasing, highlighting, emphasizing, enhancing, unprecedented, remarkable, stunning, profound, epic (non-literal), in essence, thought leader/leadership, synergy/synergies, pain points, moving forward, touch base/circle back, rest assured, it goes without saying.

## Banned phrases & openers
"In today's [adjective] [noun]…", "It's worth noting that…", "It's important to note that…", "Let's dive in/dive deeper/delve into", "At its core…", "In the realm of…", "When it comes to…", "Not just X, but Y", "It's not just about X — it's about Y", "This is where X comes in", "Whether you're a X or a Y…", "From X to Y" (range opener), "At the end of the day…", "The bottom line is…", "Here's the thing…", "Here's the deal…", "In a nutshell…", "Buckle up", "Take it to the next level", "Unlock the power of…", "Empower/empowering", "Elevate your…", "Streamline your…", "Supercharge your…", "Bridge the gap", "Move the needle", "In conclusion", "Overall," (paragraph starter), "Firstly… Secondly… Thirdly…". The dismissive-negation fragment "No X." / "Not another Y." as a punchy one-liner pivot — "No theory.", "No fluff.", "No BS.", "No gatekeeping.", "Not another listicle." — reads as manufactured LinkedIn-AI hype; make the point in a real sentence instead, or cut it. Never open with: "Certainly,", "Absolutely,", "Sure,", "Great question!", "I'd be happy to…", "Moreover,", "Furthermore,", "Additionally,", "Interestingly,", "Notably,", "Importantly,", "Indeed,".

## Structural rules (how readers spot AI even when the words are clean)
- No rule of three. AI defaults to threes — break it. Use two, four, one, five. Only group in threes when the content genuinely has three items.
- No uniform sentence length. Never three consecutive sentences of similar length. Mix 4-word sentences with 30-word ones — this is the single most measurable AI tell.
- No parataxis. Don't chain short declaratives ("Short sentence. Then another. Then another."). Connect related thoughts with subordinate clauses, conjunctions, semicolons, commas — show causation, contrast, qualification.
- No hedging seesaw. Pick a side, state it plainly; acknowledge a counterpoint in one sentence max.
- No corporate pep-talk / cheerleading tone. Write like someone with real experience, including the frustrating parts.
- No identical paragraph structure (topic → explain → example → transition). Start some with a question, some with a blunt statement; let some be one sentence; let some end with no transition.
- No "As a [role], I…" openers. Just say the thing.
- Prefer active voice; avoid "is being done", "was found to be".
- Let paragraphs end abruptly — not every one needs a summary or transition.

## Punctuation
- Em dashes (—): do NOT use them at all (the most-cited AI tell). Use commas, semicolons, colons, parentheses, or new sentences instead. (Even one stands out as machine-written on LinkedIn.)
- Exclamation marks: at most one per ~1,000 words. Enthusiasm comes from word choice.
- Ellipses only when genuinely trailing off, never as a transition.
- Use semicolons and colons naturally (AI underuses them).

## Do this instead
- Be specific, not general: "tells you you'll run out of USDC in 47 days" beats "powerful analytics". Use real numbers, name real things, include friction/doubt/mess, use contractions, reference time and place. Use the less obvious word — reach past the first token that comes to mind. Let sentences be ugly sometimes (a fragment; a run-on that keeps going because the thought isn't done).
- NEVER invent anecdotes, data, studies, statistics, or quotes, or present a hypothetical as real. Use "imagine…"/"suppose…" for hypotheticals; "roughly"/"around" when you don't have a real number. Fabricated specificity is worse than honest vagueness.

## Formatting (LinkedIn / social)
No markdown headers. No bolding random phrases for emphasis. No emoji-as-bullets (one or two emoji total is fine if it fits the voice). No "🧵"/"Thread:" openers. No hashtag stacks (zero to two, integrated naturally).
Paragraph spacing is not optional: a LinkedIn post is SHORT paragraphs separated by a BLANK LINE — the hook stands alone, then each beat, then the CTA, each its own one-or-two-sentence paragraph with whitespace between. Never deliver a post as one dense block of text; that wall is the single most common formatting failure. When you call render_post, the body must contain real blank lines (a double newline) between paragraphs, exactly as it should appear in the LinkedIn composer.

Final check before any draft: would this read as AI-written, or could any AI have written it for any person? If so, make it specific and human until the answer is no. Apply all of this silently — never reference these rules in your reply.`;

// Pick the skills whose triggers appear in the user's latest message. Caps at
// `max` (most-recently-defined wins ties is not needed; order is registry order)
// to keep the injected block small and the prompt lean.
export function selectSkills(userMessage: string, max = 2): Skill[] {
  const text = userMessage.toLowerCase();
  const hits = SKILLS.filter((s) => s.triggers.some((t) => text.includes(t)));
  return hits.slice(0, max);
}

// Render the selected skills into one context block for the prompt. Empty string
// when nothing matched (caller skips injection entirely).
export function renderSkills(skills: Skill[]): string {
  if (!skills.length) return "";
  return (
    "The following task-specific guidance applies to this request. Follow it closely:\n\n" +
    skills.map((s) => s.body).join("\n\n---\n\n")
  );
}

// Render the task-specific skill block from BOTH the keyword-selected built-in
// skills AND the user's chosen custom skills (their bodies, resolved server-side
// by the stream route). One combined block so the injection point in
// buildMessages stays a single uncached system message.
//
// INVARIANT: when there are NO custom bodies, this returns EXACTLY what
// renderSkills(builtins) returns — so a turn that doesn't use a custom skill
// assembles a byte-identical prompt to before this feature existed. (Verified by
// test.) Custom guidance is framed as USER-AUTHORED and explicitly SUBORDINATE
// to the global writing/structural rules, so a custom skill can't override the
// anti-slop guarantees (which also still run as server-side nets regardless).
export function renderCombinedSkills(
  builtins: Skill[],
  customBodies: string[],
  customNames: string[] = [],
): string {
  const builtinBlock = renderSkills(builtins);
  const clean = customBodies.map((b) => b.trim()).filter(Boolean);
  if (clean.length === 0) return builtinBlock; // byte-identical to before

  // Label each body with its /slug when names are available, so the agent can
  // resolve user phrasing like "use that skill" / "with /cta" / "apply our
  // skill" to the right guidance. The original framing left the bodies
  // unlabeled, and the agent then asked "which skill?" because nothing in
  // context named what the user was pointing at.
  const sections = clean.map((body, i) => {
    const name = customNames[i];
    return name ? `## /${name}\n${body}` : body;
  });
  const list =
    customNames.length > 0
      ? `: ${customNames.map((n) => `/${n}`).join(", ")}`
      : "";

  const customBlock =
    `The user invoked their own saved skill${clean.length > 1 ? "s" : ""}${list} for this request. ` +
    `Apply this guidance — it's why they picked it. When the user references ` +
    `"this skill" / "that skill" / "the skill" / "our skill," they mean the block(s) below. ` +
    `If anything here conflicts with the global writing rules above ` +
    `(no AI tells, no em dashes, formatting, voice), those always win:\n\n` +
    sections.join("\n\n---\n\n");

  return builtinBlock ? `${builtinBlock}\n\n---\n\n${customBlock}` : customBlock;
}
