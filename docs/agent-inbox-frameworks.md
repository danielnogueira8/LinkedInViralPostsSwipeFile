# Agent inbox — framework-driven redesign

Status: **implemented.** The daily feed now puts Trend Radar first and keeps
only the evergreen personal-story and educational lanes. Newsjacking remains
available as an explicit Cowork writing skill, but is no longer a daily inbox
agent.

## The premise

The daily opportunity feed uses three visible decisions:

1. **Trend Radar** — surfaces a fresh external signal for human review.
2. **Personal achievements, struggles, or stories** — the author's own
   material.
3. **Educational** — showcases expertise the author has demonstrated.

Newsjacking and namejacking remain intentional manual skills in Cowork. They
are not daily inbox lanes because Trend Radar already owns timely external
discovery, and a separate newsjacking queue duplicated that decision.

The feed should suggest highly relevant, personalized ideas grounded in
workspace evidence, while staying honest when the evidence is weak.

## Current implementation

### Framework lanes

The inbox lanes describe **what kind of post to write**, while evidence remains
provenance shown on the card. The synthesis prompt and server quality gates
enforce the distinction, so a personal story cannot quietly become a generic
explainer.

| Lane | Needs | Source |
|---|---|---|
| `trend_radar` | a fresh external signal, clearly marked for review | creator-independent Trend Radar discovery |
| `personal_story` | a story, proof, or belief from the user | `workspace_knowledge_items` |
| `educational` | a topic with demonstrated results | workspace learning signals or approved knowledge |

Trend Radar is persisted by its creator-independent scanner and exposed through
the same feed/card contract as the other lanes. It is the first filter in the
feed and the first workflow on the Claude Workflows page.

### Personalization as material

`knowledgeDetail()` extracts structured kinds such as `story`, `belief`,
`proof`, `offer`, `audience_insight`, and `topic_expertise`. These become the
raw material for the personal-story lane and the credibility anchor for the
educational lane.

### Newsjacking in Cowork

The authored `/newsjacking` skill remains in `lib/agent/skills/index.ts`. When
someone explicitly asks Cowork to newsjack a current event, the normal grounded
news research path still applies. Removing the daily inbox lane does not remove
that writing capability.

## Retirement behavior

- New daily runs no longer request, search for, or synthesize Newsjacking ideas.
- The Newsjacking filter is removed from the feed.
- Existing Newsjacking rows are retained for history and deduplication, but are
  not returned to the current feed.
- No historical rows are deleted and no database migration is needed for the
  retirement.

## Open consideration

The personal-story lane still depends on interview depth. If a Workspace has
thin `workspace_knowledge_items`, that lane should remain empty rather than
inventing a story; the fix belongs upstream in the interview, not in the inbox.
