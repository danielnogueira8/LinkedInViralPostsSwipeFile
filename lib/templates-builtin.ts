import type { BuiltinTemplate } from "./templates";

// ---------------------------------------------------------------------------
// Built-in content templates — app-owned, generic post structures.
//
// These are NOT DB rows (like the built-in agent skills in
// lib/agent/skills/index.ts, they live in code so they always ship and are the
// single source of truth). They seed the templates library so it's useful on
// day one; a workspace's own custom templates layer on top. Rendered read-only
// in the UI (no edit/delete); "Model in Chat" stashes the body like any source.
//
// Each is a GENERIC fill-in-the-blank skeleton with {placeholder} tokens — a
// structure to model a new post after, deliberately not derived from any one
// scraped post. Bodies use real blank lines between paragraphs (the LinkedIn
// shape) and avoid the AI tells the global writing rules ban.
//
// ids are stable "builtin:<slug>" strings so the client can key/deep-link them
// without colliding with the uuid ids of custom (DB) templates.
// ---------------------------------------------------------------------------

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: "builtin:client-win-story",
    title: "Client win story",
    category: "story",
    source: "builtin",
    body: `{time period} ago, {client or subject} was {painful starting situation}.

{One concrete detail that shows how bad it was.}

We changed one thing: {the specific change you made}.

{What happened next: the turn, with a real number or moment.}

Now {the new reality / result}.

The lesson isn't {the obvious takeaway everyone assumes}. It's {the real, less-obvious takeaway}.`,
  },
  {
    id: "builtin:contrarian-take",
    title: "Contrarian take",
    category: "contrarian",
    source: "builtin",
    body: `Everyone tells you to {common advice in your space}.

I did that for {time period}. Here's what it actually got me: {the disappointing or backfiring result}.

The problem: {why the common advice quietly fails, specifically}.

What works instead: {your alternative, stated plainly}.

{One concrete example or number that backs it up.}

{Optional: who this does and doesn't apply to.}`,
  },
  {
    id: "builtin:numbered-lessons",
    title: "Numbered lessons / breakdown",
    category: "listicle",
    source: "builtin",
    body: `{Number} things I learned about {topic} after {credibility marker: years, projects, clients}:

1. {First lesson.} {One sentence that earns it, not a bare line.}

2. {Second lesson.} {Why it matters, concretely.}

3. {Third lesson.} {A detail or number.}

4. {Fourth lesson.} {The one people get wrong.}

The one I wish I'd known first: {the most important, called out}.`,
  },
  {
    id: "builtin:before-after",
    title: "Before / after transformation",
    category: "before_after",
    source: "builtin",
    body: `Before: {the messy starting state, with a real detail}.

After: {the concrete end state, with a number or specific outcome}.

Here's exactly what changed in between:

{The specific move #1 you made.}

{The specific move #2, and the friction or doubt you hit.}

It took {honest timeframe}, not {the unrealistic timeframe people expect}.`,
  },
  {
    id: "builtin:lead-magnet",
    title: "Lead magnet / giveaway",
    category: "lead_magnet",
    source: "builtin",
    body: `I built {the resource, name it specifically} that {the specific outcome it delivers}.

{One line of proof or the pain it removes.}

Inside:
- {Concrete asset or section 1}
- {Concrete asset or section 2}
- {Concrete asset or section 3}

It's yours free. Comment "{keyword}" and I'll send it over.

(No link, no signup, just comment and I'll DM you.)`,
  },
  {
    id: "builtin:single-insight",
    title: "Single insight",
    category: "single_insight",
    source: "builtin",
    body: `{One non-obvious claim about your space, stated as fact.}

Most people assume {the common assumption}. But {the reason that's wrong}.

Here's what's actually going on: {the mechanism / your reasoning, 2-3 sentences}.

{One real example that makes it concrete.}

So if you're {the reader's situation}, {the practical implication for them}.`,
  },
  {
    id: "builtin:question-led",
    title: "Question-led / observation",
    category: "question",
    source: "builtin",
    body: `Why does {a genuine, specific question about your space}?

I kept running into this with {who / where you saw it}.

The usual answer is {the surface-level answer}, but that never sat right with me.

Here's what I think is really going on: {your take, worked through}.

{The point, landed plainly, no forced CTA.}`,
  },

  // ---- NAMEJACKING: borrow a recognizable PERSON's attention ----
  // Rules baked in: name someone your ICP actually follows, be accurate (never
  // invent a quote), add a real insight, punch up or sideways. The four lanes.
  {
    id: "builtin:namejack-agree-extend",
    title: "Namejack: Agree & Extend",
    category: "namejack",
    source: "builtin",
    body: `{Recognizable person} says {their actual take, stated accurately}.

They're right. But most people stop one step too early.

Here's the part that gets missed: {the nuance or next move nobody adds}.

{The concrete lesson / framework the reader keeps, 2-3 lines with a real example.}

Try this for {short timeframe} and watch what changes: {the specific action}.`,
  },
  {
    id: "builtin:namejack-contrarian",
    title: "Namejack: Respectful Contrarian",
    category: "namejack",
    source: "builtin",
    body: `Everyone's quoting {recognizable person} on {their well-known advice}.

For {the segment it fails, e.g. a 4-person team or a pre-revenue founder}, that advice quietly backfires.

Here's why: {the specific reason the advice breaks for this group}.

What works instead: {your alternative, stated plainly, with one concrete detail}.

Credit where it's due, {person} is right for who they were talking to. Just not for {this segment}.`,
  },
  {
    id: "builtin:namejack-decode",
    title: "Namejack: Decode / Reverse-engineer",
    category: "namejack",
    source: "builtin",
    body: `I studied {a real, verifiable thing the person made: 30 of their posts, their sales clips, one famous piece}.

The whole thing runs on {number} moves.

{Move 1, one line.}

{Move 2, one line, with what makes it work.}

{Move 3 or 4 if the content genuinely has that many, one line each.}

Here's the same system applied to {the reader's world}: {a short worked example}.

Steal this for {the reader's next concrete use}.`,
  },
  {
    id: "builtin:namejack-apply-translate",
    title: "Namejack: Apply / Translate",
    category: "namejack",
    source: "builtin",
    body: `{Recognizable person} does {their known move} in {their field}.

Here's how {the reader's role} should steal it for {the reader's field}.

The principle underneath it: {the transferable idea, one line}.

How to run it:
{Step 1 translated to the reader's world.}
{Step 2, with the friction or doubt they'll hit.}

Do it well and {the concrete payoff, tied to a real number or outcome}.`,
  },

  // ---- BRANDJACKING: borrow a well-known BRAND/company's attention ----
  // Rules baked in: pick a brand the audience knows, be factual (never invent a
  // metric — label speculation as your read), reference don't impersonate, add
  // real analysis, punch up or sideways. The six lanes.
  {
    id: "builtin:brandjack-teardown",
    title: "Brandjack: Teardown",
    category: "brandjack",
    source: "builtin",
    body: `I analyzed {well-known brand}'s {specific surface: onboarding, pricing page, checkout, emails}.

{Number} things they nail. One they quietly botch.

What they nail: {the strong move, and why it works}.

Where it breaks: {the specific friction point, described concretely}.

Steal the fix for your own {equivalent surface}:
{Fix 1.}
{Fix 2, with the detail most people skip.}`,
  },
  {
    id: "builtin:brandjack-steal-this",
    title: "Brandjack: Steal-this",
    category: "brandjack",
    source: "builtin",
    body: `{Well-known brand} spends {a real, verifiable amount or effort} on {the thing they do}.

A {small-team descriptor, e.g. 2-person brand} can copy 80% of it for close to nothing.

The principle they're actually using: {the transferable move, one line}.

How to steal it lean:
{Cheap version of the move, step 1.}
{Step 2, concrete.}

You won't match their budget. You don't need to, to get {the outcome that matters}.`,
  },
  {
    id: "builtin:brandjack-contrarian",
    title: "Brandjack: Contrarian",
    category: "brandjack",
    source: "builtin",
    body: `Everyone tells you to copy {well-known brand}'s {famous approach}.

For {the segment, e.g. a pre-PMF startup}, copying it is how you stall.

Here's the trap: {why the approach fails for this group, specifically}.

What to do instead: {the alternative, with one concrete example}.

The line where copying them starts to make sense: {the milestone or condition}. Not before.`,
  },
  {
    id: "builtin:brandjack-versus",
    title: "Brandjack: Versus (A vs B)",
    category: "brandjack",
    source: "builtin",
    body: `{Brand A} vs {Brand B} isn't about features.

It's two opposite bets on {the underlying thing: how people work, buy, or learn}.

{Brand A}'s bet: {what they optimize for, and who it suits}.

{Brand B}'s bet: {the opposite, and who it suits}.

What a {the reader's role} should actually learn from the matchup: {the positioning lesson}.

If you're {reader's situation}, model {the one that fits} and skip the other's playbook.`,
  },
  {
    id: "builtin:brandjack-commentary",
    title: "Brandjack: Commentary / Prediction",
    category: "brandjack",
    source: "builtin",
    body: `{Well-known brand} just {a real, public move: a price change, a launch, a campaign}.

It looks like {the surface read everyone has}.

It's actually {the smarter strategy underneath, labeled as your read}.

Here's the logic: {walk the strategy in 2-3 lines}.

What {the reader's role} can borrow from the framing: {the applicable takeaway}.`,
  },
  {
    id: "builtin:brandjack-underdog",
    title: "Brandjack: Underdog / Reframe",
    category: "brandjack",
    source: "builtin",
    body: `{Well-known brand} wants you to think you need {their expensive thing} for everything.

For most of what you do (call it 80%), you don't.

Reframe the decision: {the real question the reader should be asking}.

The lean setup that covers most of it:
{Option 1, cheaper or simpler.}
{Option 2, and when you'd actually upgrade.}

Save the money for {where it actually moves the needle}.`,
  },

  // ---- LINKEDIN NORMAL POSTS: the strongest non-lead-magnet patterns ----
  // From the linkedin-normal-posts skill's analyzed patterns. Each is a proven
  // structure; fill the blanks with real specifics. No AI tells (no rule of
  // three, no em dashes, varied sentence length), blank-line paragraph breaks.
  {
    id: "builtin:pov-post",
    title: "POV post (relatable scenario)",
    category: "story",
    source: "builtin",
    body: `pov: {a specific, relatable scenario your reader is living}.

{One vulnerable, honest line about how it actually feels.}

I used to think {the old belief}. Then {the small moment that changed it}.

Here's what I know now: {the universal truth, said plainly}.

{A warm closing line to the reader, no hard CTA.}`,
  },
  {
    id: "builtin:transformation-lessons",
    title: "Transformation + numbered lessons",
    category: "before_after",
    source: "builtin",
    body: `{Time period} ago: {the old state, one concrete detail}.

Today: {the new state, with a real number or outcome}.

Here are the {number} things that actually moved the needle:

1. {Lesson.} {One line that earns it.}

2. {Lesson.} {The mindset shift, not just the tactic.}

3. {Lesson.} {The one people skip.}

4. {Lesson, if the content genuinely has four.}

None of it was a hack. It was {the real, unglamorous driver}.`,
  },
  {
    id: "builtin:tool-stack",
    title: "Tool stack / resource list",
    category: "listicle",
    source: "builtin",
    body: `I've tried {an honest, specific share, e.g. most} of the {category} tools out there.

After {credibility marker: projects, clients, years}, these are the ones I actually keep open:

{Tool 1} for {what it does} because {the specific reason it beats alternatives}.

{Tool 2} for {job}, and here's how I use it: {the non-obvious workflow}.

{Tool 3} when {the situation it's right for}.

I don't switch tools for fun. Each one earns its place by {the outcome}.

Want my exact {workflow / setup}? Comment "{keyword}" and I'll send it.`,
  },
  {
    id: "builtin:framework-breakdown",
    title: "Framework breakdown (named system)",
    category: "listicle",
    source: "builtin",
    body: `Most people struggle with {the problem} because they have no system for it.

I use one I call {framework name}. Here's the whole thing:

{Step 1} -> {what it produces}

{Step 2} -> {what it produces}

{Step 3} -> {what it produces}

{Step 4, if the process genuinely has four steps} -> {result}

That's it. Run it in order and {the concrete payoff}.

Save this for the next time you {the trigger situation}.`,
  },
  {
    id: "builtin:truth-bomb",
    title: "Contrarian truth bomb",
    category: "contrarian",
    source: "builtin",
    body: `{A common belief in your space} is wrong.

Not "needs nuance" wrong. Actually wrong.

Here's what the data (and {your experience}) actually shows: {the evidence, one or two lines}.

The real reason it persists: {why people keep believing it}.

What to do instead: {your reframe, stated as a clear position}.`,
  },
  {
    id: "builtin:case-study-results",
    title: "Case study / results breakdown",
    category: "before_after",
    source: "builtin",
    body: `{An impressive, specific metric or outcome you or a client hit}.

Here's exactly how it happened (no secret sauce, just the steps):

{Step 1, what you did and why.}

{Step 2, the part that felt risky.}

{Step 3, where the compounding kicked in.}

The part most people miss: {the non-obvious lever that actually drove it}.

It's replicable. Here's how you'd start: {the first concrete move for the reader}.`,
  },
  {
    id: "builtin:trend-shift",
    title: "Industry shift / trend analysis",
    category: "single_insight",
    source: "builtin",
    body: `{A thing in your space} is quietly {dying / changing}. Most people haven't noticed yet.

Here's the evidence: {the concrete signal you're seeing}.

What's actually happening underneath: {your read of the shift, 2-3 lines}.

The new mental model: {the reframe the reader should adopt}.

If you're {the reader's role}, here's how to position for it now: {the practical move}.`,
  },
  {
    id: "builtin:beginner-avoid-instead",
    title: "Beginner's guide (avoid vs instead)",
    category: "listicle",
    source: "builtin",
    body: `You're overcomplicating {the topic}. Almost every beginner does.

If you're just starting with {the thing}, here's the shortcut.

Stop doing this:
{Avoid 1}
{Avoid 2}
{Avoid 3}
{Avoid 4}

Do this instead:
{Instead 1}
{Instead 2}
{Instead 3}
{Instead 4}

Give it {a manageable timeframe, e.g. 3 weeks}. Then {the simple next step}.`,
  },
  {
    id: "builtin:story-with-moral",
    title: "Story with a moral (implied lesson)",
    category: "story",
    source: "builtin",
    body: `{A one-line teaser that promises a story worth reading.}

{Set the scene: who, where, when, one grounding detail.}

Then {the obstacle or turning point} happened.

{The emotional stakes, said simply. What was on the line.}

So {the character} did {the decisive, specific action}.

{The consequence, short-term and long-term.}

I still think about it every time I {the situation it applies to}.`,
  },
  {
    id: "builtin:formula-reveal",
    title: "Formula / equation reveal",
    category: "listicle",
    source: "builtin",
    body: `I used to be terrible at {the skill}. Then I found the formula.

{Thing A} + {Thing B} + {Thing C} = {the outcome}.

Here's what each part looks like in practice:

{Thing A}: {a fill-in-the-blank example}.

{Thing B}: {an example}.

{Thing C}: {an example}.

Bonus: {one extra tip that makes it hit harder}.

Steal the formula. Swap in your own specifics.`,
  },
  {
    id: "builtin:meta-writing-tips",
    title: "Meta writing / platform tips",
    category: "listicle",
    source: "builtin",
    body: `Most {content / posts} in {your niche} get ignored for the same fixable reasons.

Here's what actually gets read:

{Tip 1} -> {the benefit / why it works}

{Tip 2} -> {the benefit}

{Tip 3} -> {the benefit}

{Tip 4, if you genuinely have four} -> {the benefit}

The through-line: {the one principle underneath all of them}.

(This post is built on those rules. That's the proof.)`,
  },
  {
    id: "builtin:milestone-reflection",
    title: "Milestone reflection",
    category: "story",
    source: "builtin",
    body: `{A shocking or specific stat about your journey}.

{A counter-line that reframes it.}

{Time period} ago I was {the humble starting point}.

Since then: {a real achievement}. {Another}. {A more personal one}.

None of it felt inevitable at the time.

If I had to pass on one thing I learned: {the hard-won wisdom, one line}.

{An honest, warm question to the reader to open the conversation.}`,
  },
];

// Look up a built-in by its "builtin:<slug>" id. Returns null for a non-builtin
// or unknown id — so the "Model in Chat" path can resolve either a built-in
// (from here) or a custom template (from the DB) by id.
export function getBuiltinTemplate(id: string): BuiltinTemplate | null {
  if (!id.startsWith("builtin:")) return null;
  return BUILTIN_TEMPLATES.find((t) => t.id === id) ?? null;
}
