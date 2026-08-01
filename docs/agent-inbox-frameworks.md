# Agent inbox — framework-driven redesign

Status: **implemented.** Captured 2026-07-30; the queue and framework lanes are
now implemented through migration 166.

## The premise

The daily opportunity queue uses four distinct decisions:

1. **Newsjacking** — builds on a currently, *culturally* relevant event and
   adapts it to the niche. The event does **not** have to be niche news: World
   Cup, awards shows, a film everyone is discussing, a viral moment. The
   adaptation to the niche is the creative work.
2. **Personal achievements, struggles, or stories** — the author's own
   material.
3. **Educational** — showcases expertise.
4. **Trend Radar** — surfaces a fresh conversation for human review before it
   becomes a tracked-creator signal.

Namejacking remains an intentional manual skill, but is not a daily inbox lane:
it overlaps with Newsjacking and made the review queue wider without adding a
distinct decision.

The inbox should suggest super-relevant, up-to-date, personalized daily tips
grounded in these.

## Implementation notes

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

### 2. The lanes are framework decisions

The inbox lanes describe **what kind of post to write**, while evidence remains
provenance shown on the card. The synthesis prompt and server quality gates
enforce the distinction, so a personal story cannot quietly become a generic
news card.

That is the mechanism behind the observed near-duplicate cards — e.g. "The
executive profile is part of the sales process" vs "The profile is part of the
pitch before the pitch": same story, same implicit framework, two cards.
Migration 160 added a cross-day source window, which stops the same *source*
returning tomorrow, but does nothing about two cards sharing a framework today.

### 3. Personalization is used as material

`knowledgeDetail()` already extracts structured kinds:
`story`, `belief`, `proof`, `offer`, `audience_insight`, `topic_expertise`,
`prohibition`. These now become the raw material for the personal-story lane
and the credibility anchor for the educational lane.

## What already exists

The authored skills remain available in `lib/agent/skills/index.ts`, including
`newsjacking`, `namejacking`, and `brandjacking`. Newsjacking is the one
connected to the daily inbox; the other named-attention skills stay available
when explicitly requested in Cowork.

Also already loaded per run and currently underused:
- `workspace_knowledge_items` → personal stories, proof, beliefs
- `workspace_learning_snapshots` → demonstrated-results topics

## Implemented changes

### A. Split the news search in two

Keep the existing niche query. Add a **second, separate cultural-moment query**
with no niche terms — major sport, entertainment, awards, tech culture, viral
discourse. Two searches, two evidence pools, so a cultural event and a trade
story can both be on the board.

`SENSITIVE_NEWS_RE` (evidence.ts:16) already filters tragedy/crime/disaster and
matters considerably more once general news is in scope.

### B. Make the framework the lane

The queue uses four distinct, checkable decisions:

| Lane | Needs | Source |
|---|---|---|
| `newsjacking` | dated cultural event + an explicit bridge to the niche | new cultural query |
| `personal_story` | a story / proof / belief from the user | `workspace_knowledge_items` (already loaded) |
| `educational` | a topic with demonstrated results | learning signals (already loaded) |
| `trend_radar` | a fresh external signal, clearly marked for review | Trend Radar discovery |

### C. The bridge is the quality bar

For newsjacking the card must state the connection explicitly — e.g. "F1 season
finale → what pit-stop discipline says about deploy cadence." If the model
cannot produce a non-tortured bridge, **the lane goes empty** rather than
shipping a stretch. This gate is what separates the feature from generic
AI-slop newsjacking. It mirrors the existing honest-emptiness rule: no verified
news means no Newsjacking card.

### D. Pass the skill through to the draft

Each draft hand-off carries the lane's framework instructions, so acting on a
Newsjacking card starts with the newsjacking skill already applied.

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

## Scope decision

The full four-decision queue was chosen. Namedrop history is preserved by the
forward-only retirement migration and displayed as Newsjacking; no historical
rows are deleted.
