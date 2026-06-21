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

Avoid: throat-clearing ("I wanted to share…"), engagement-bait ("Agree?"), vague abstractions, corporate tone, hedging. When adapting a viral hook, keep its structure/tension, replace its specifics with the user's, and confirm it fits the ~210-char preview.`,
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

Rules: add value, don't leech. NEVER fabricate quotes/stats/positions and attribute them to a real person — describe their position generally if unsure (fake words = trust + legal risk). Punch up or sideways, never down. Relevance over fame — the name your ICP cares about beats a bigger name they don't. Have a real point; worshipful "X is a genius 🙏" adds nothing.

Picking the person: if the user already named who to namejack, draft for them directly. If they ask you to SUGGEST who (no specific name given), present 2-3 candidates with your reasoning and the lane each fits — then STOP. Do NOT draft a post yet; let the user choose. End that reply with a hidden choices block listing exactly the candidate names, one per line:
\`\`\`choices
Justin Welsh
Naval Ravikant
Jasmin Alic
\`\`\`
The choices block is parsed into clickable chips for the user — put ONLY the names in it (no numbers, no commentary). When the user then picks one, draft the namejack post for that person.`,
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

Rules: be factual — don't invent a brand's metrics, decisions, or statements (speculation only when labeled as your read). Criticism must be fair and defensible — critique the work, not invented scandals (false claims = defamation). Pick brands the audience knows. Add genuine analysis, not a shoutout. Punch up or sideways.

Picking the brand: if the user already named which brand to brandjack, draft for them directly. If they ask you to SUGGEST which (no specific brand given), present 2-3 candidates with your reasoning and the lane each fits — then STOP. Do NOT draft a post yet; let the user choose. End that reply with a hidden choices block listing exactly the candidate brand names, one per line:
\`\`\`choices
Notion
Linear
Figma
\`\`\`
The choices block is parsed into clickable chips for the user — put ONLY the names in it (no numbers, no commentary). When the user then picks one, draft the brandjack post for that brand.`,
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
