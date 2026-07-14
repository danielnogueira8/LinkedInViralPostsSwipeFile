# Content Source Discovery

## Product contract

Content Sources has two jobs:

1. `Explore creators` helps an inexperienced LinkedIn user find credible examples by topic and add a balanced starter set.
2. `My sources` helps a workspace operate the creators it already tracks.

The global creator catalog belongs to SwipeIn. Tracking is workspace-owned. A recommended baseline creator therefore has `manual_owner_workspace_id is null`; adding that creator to a workspace creates or preserves only a `workspace_accounts` membership.

## Taxonomy

Keep the existing stable category IDs while normalizing their labels:

- `linkedin-content` — LinkedIn & Personal Brand
- `ai` — AI & Technology
- `automation` — Automation & No-Code
- `outreach` — Sales & Outreach
- `gtm` — Marketing & Growth
- `ads` — Paid Ads & Creative
- `seo` — SEO & Organic Growth
- `agency-operations` — Agency & Services
- `investor` — Investing & Fundraising
- `founders-startups` — Founders & Startups
- `creator-economy` — Creator Economy & UGC

Workspace categories remain private and appear separately from the global taxonomy.

## Discovery behavior

- Search creator name, handle, headline, recommendation reason, and discovery tags.
- Filter with plain topic controls; category controls never contain a hidden bulk-tracking action.
- Sort by best match, most saved posts, highest engagement, or name.
- Explain recommendations with a short headline, reason, and topic tags.
- Offer curated starter packs that contain only global baseline creators and balance the selected topics.
- Keep manual creators editable by their owning workspace. Global creators are read-only catalog entries.
- On mobile, topics collapse into horizontal controls above a single-column creator list.

## Data cleanup

- Add the approved creators discovered from the signed-in LinkedIn feed as global baseline rows.
- Normalize exact LinkedIn handles and enforce case-insensitive uniqueness.
- Merge exact-handle duplicates without losing posts or workspace memberships.
- Apply only high-confidence category and name corrections; leave ambiguous creators unchanged.

## Acceptance

- A user can understand the difference between discovery and source management without instruction.
- A new user can choose topics and track a starter pack in one bulk action.
- Existing workspace memberships, posts, manual ownership, and private categories remain intact.
- Unit contracts, migration checks, lint, type checking/build, and signed-in browser QA pass.
