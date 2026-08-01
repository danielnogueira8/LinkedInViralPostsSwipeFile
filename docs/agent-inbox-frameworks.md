# Agent inbox — framework-driven redesign

Status: **design note, not built.** Captured 2026-07-30 from a review of the
inbox as it exists at PR #1706 / migration 160.

## The premise

The LinkedIn posts that actually land follow one of four frameworks:

1. **Newsjacking** — builds on a currently, *culturally* relevant event and
   adapts it to the niche. The event does **not** have to be niche news: World
   Cup, awards shows, a film everyone is discussing, a viral moment. The
   adaptation to the niche is the creative work.
2. **Personal achievements, struggles, or stories** — the author's own
   material.
3. **Name/brandjacking** — borrows attention from a known person or company
   and builds the post on top of that.
4. **Educational** — showcases expertise.

The inbox should suggest super-relevant, up-to-date, personalized daily tips
grounded in these.

## Why the current inbox cannot produce three of the four

### 1. The news query is niche-scoped, so cultural moments are unreachable

`lib/agent-inbox/evidence.ts:321` builds every news search as:

```
{topics} OR ... latest announcements, product changes, research, and industry developments
```

`topics` resolves from workspace preferences → learned topics → knowledge
labels → account niches. Every path is the user's own niche, and the trailing
clause pins it to trade press. A World Cup final or an awards show can never
enter the evidence bundle, so framework #1 as defined above is structurally
impossible. The "News Agent" on the board is really a *trade-press* agent.

**This one line is the highest-leverage change in the whole redesign.**

### 2. The lanes are an evidence axis, not a framework axis

`now` / `proven` / `explore` describe **where evidence came from**. The four
frameworks describe **what kind of post to write**. The synthesis prompt
(`lib/agent-inbox/synthesis.ts`) never names a framework, so a `proven` card
and an `explore` card can differ only by sourcing.

That is the mechanism behind the observed near-duplicate cards — e.g. "The
executive profile is part of the sales process" vs "The profile is part of the
pitch before the pitch": same story, same implicit framework, two cards.
Migration 160 added a cross-day source window, which stops the same *source*
returning tomorrow, but does nothing about two cards sharing a framework today.

### 3. Personalization is used as a search term, not as material

`knowledgeDetail()` (evidence.ts:186) already extracts structured kinds:
`story`, `belief`, `proof`, `offer`, `audience_insight`, `topic_expertise`,
`prohibition`. Today those only ever become *search keywords*. They are the
natural raw material for the personal-story lane and the credibility anchor for
the educational lane.

## What already exists (this is mostly wiring, not authoring)

Three of the four frameworks are already authored skills in
`lib/agent/skills/index.ts`: `newsjacking`, `namejacking`, `brandjacking`
(plus `anti-ai`). They are not reachable from the inbox.

Also already loaded per run and currently underused:
- `workspace_knowledge_items` → personal stories, proof, beliefs
- `workspace_learning_snapshots` → demonstrated-results topics

## Proposed changes

### A. Split the news search in two

Keep the existing niche query. Add a **second, separate cultural-moment query**
with no niche terms — major sport, entertainment, awards, tech culture, viral
discourse. Two searches, two evidence pools, so a cultural event and a trade
story can both be on the board.

`SENSITIVE_NEWS_RE` (evidence.ts:16) already filters tragedy/crime/disaster and
matters considerably more once general news is in scope.

### B. Make the framework the lane

Replace `now` / `proven` / `explore` with the four frameworks. Each then has a
distinct, checkable evidence requirement:

| Lane | Needs | Source |
|---|---|---|
| `newsjacking` | dated cultural event + an explicit bridge to the niche | new cultural query |
| `personal_story` | a story / proof / belief from the user | `workspace_knowledge_items` (already loaded) |
| `namejacking` (incl. brand) | a named person or company in current discourse | either news query |
| `educational` | a topic with demonstrated results | learning signals (already loaded) |

### C. The bridge is the quality bar

For newsjacking the card must state the connection explicitly — e.g. "F1 season
finale → what pit-stop discipline says about deploy cadence." If the model
cannot produce a non-tortured bridge, **the lane goes empty** rather than
shipping a stretch. This gate is what separates the feature from generic
AI-slop newsjacking. It mirrors the existing honest-emptiness rule for `now`
(index.ts: no verified news → no `now` card).

### D. Pass the skill through to the draft

Each lane maps to its existing skill, so acting on a newsjacking card starts
the draft with the newsjacking skill already applied.

## Risks / open questions

- **Taste risk on cultural newsjacking.** The failure mode is cringe, and the
  sensitive-topic filter is keyword-based. Suggested rollout: cap `newsjacking`
  at one card/day, review real picks for a few days before widening.
- **Cannot be validated by tests.** Pick *quality* needs a human looking at
  several days of real cards; tests can only cover routing, dedupe, and gates.
- **Personal-story lane depends on interview depth.** If
  `workspace_knowledge_items` is thin for a workspace, that lane is empty and
  the real fix is upstream in the interview, not in the inbox. Worth checking
  actual row counts for a live workspace before building.

## Scope decision (open)

Two options, not yet chosen:

1. **Full four-lane replacement** — the whole redesign above.
2. **Cultural-news split only** — add the second query, keep today's lanes.
   Smaller, and tests the riskiest assumption (do cultural picks feel good?)
   before committing to the lane rework.
