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
| `personal_story` | one source post plus a verified story, proof, or belief from the user | tracked/bookmarked swipe-file post + `workspace_knowledge_items` |
| `educational` | one source post plus demonstrated results or approved expertise | tracked/bookmarked swipe-file post + workspace learning signals or approved knowledge |

### Source-aware pairing

The two evergreen agents do not invent a post from a source post alone. Every
ready-to-use opportunity pairs two different roles:

1. **Source Post / inspiration** — an actual tracked swipe-file post or saved
   bookmark. It contributes the reusable shape: opening move, narrative arc,
   contrast, or teaching progression.
2. **Workspace evidence / anchor** — verified knowledge or a measured learning
   signal belonging to this Workspace. It contributes the user's original
   story, belief, proof, expertise, or result.

The model may borrow structure, but must not copy the source's wording, claims,
names, numbers, clients, or results. Recent drafts are context only; they are
not treated as external posts to model. If either half of the pair is missing,
the lane stays empty instead of producing a generic or fabricated idea.

Source posts are loaded from both canonical tracked-account discovery and the
Workspace's `saved_posts`, then canonical-URL deduplicated and ranked by topic
fit, freshness, engagement, and bookmark curation. The evidence contract stores
the source post id and URL. Opening an evergreen idea first creates the normal
scoped Cowork modeling-source record, so the composer can show the source chip
and submitted turns retain structured `source_post_id` attribution rather than
relying on a pasted URL or a generic text reference.

Trend Radar is persisted by its creator-independent scanner and exposed through
the same feed/card contract as the other lanes. It is the first filter in the
feed and the first workflow on the Claude Workflows page.

### Personalization as material

`knowledgeDetail()` extracts structured kinds such as `story`, `belief`,
`proof`, `offer`, `audience_insight`, and `topic_expertise`. These become the
user-owned anchor for the personal-story lane and, where relevant, the
credibility anchor for the educational lane. Learning signals carry the same
anchor role when they meet confidence and sample-size gates.

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

The personal-story lane still depends on interview depth and the source-post
pool. If a Workspace has thin `workspace_knowledge_items`, no modelable source
post, or both, that lane should remain empty rather than inventing a story; the
fix belongs upstream in the interview or source collection, not in the inbox.
