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
];

// Look up a built-in by its "builtin:<slug>" id. Returns null for a non-builtin
// or unknown id — so the "Model in Chat" path can resolve either a built-in
// (from here) or a custom template (from the DB) by id.
export function getBuiltinTemplate(id: string): BuiltinTemplate | null {
  if (!id.startsWith("builtin:")) return null;
  return BUILTIN_TEMPLATES.find((t) => t.id === id) ?? null;
}
