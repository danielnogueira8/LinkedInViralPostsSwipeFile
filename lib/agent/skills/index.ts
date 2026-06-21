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

export const SKILLS: Skill[] = [HOOKS, LEAD_MAGNET, VOICE_MATCH];

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
