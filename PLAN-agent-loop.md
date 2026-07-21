# PLAN — The Agent Loop ("your content agent")

Status: IN PROGRESS. Written 2026-07-20 as a complete handoff spec; updated
2026-07-21 with execution status. Any LLM harness or engineer should be able to
execute the remaining phases cold, without the conversation that produced it.

**Execution status (2026-07-21)**
- ✅ Phase A — structure matching engine (PR #1307). Default-on.
- ❌ Phase B — two-draft presentation (PR #1308). DROPPED: too much complexity;
  keep modeled-only drafting and continuous learning on modeled posts instead.
- ✅ Phase C — edit-delta learning (PR #1309). Migration 118.
- ⬜ Phase D — agent loop (scan → rank → act daily). Migration 119.
- ⬜ Phase E — "While you were away" home surface.
- ⬜ Phase F — Plan-my-week (ephemeral planner).

---

## 1. Product vision (the "why", in one paragraph)

The app stops being a chat tool you operate and becomes an agent that works
while you're away. It watches the user's tracked niche (scraped daily),
detects what's working (per-creator outliers, news hooks, pattern shifts), and
— autonomously, within hard caps — drafts posts grounded in that material, in
the user's voice, for review. The user never writes from scratch and never
receives an UNGROUNDED draft: every post is built from a source, a template, a
news hook, or the user's own performance data. Ungrounded writing is ChatGPT's
commodity; grounding + voice + the learning loop is the moat.

Two directions of initiative on ONE surface (the Cowork chat):
- **The loop works the niche** (push): "While you were away" — drafts ready
  for review + one-line proposals.
- **Cowork works the user** (pull): the chat stays the intake for the user's
  own ideas, the refinement surface, the steering channel ("skip that
  creator", "more like this"), and the place the agent explains itself.

Invariant, absolute: **nothing ever auto-publishes.** Every draft — human- or
agent-initiated — is reviewed before scheduling/publishing.

## 2. Non-negotiable architectural principles

These were hard-won in the phase 0–3 rebuild (see PLAN-cowork-unification.md).
Every phase below must obey them:

1. **Deterministic until the last step.** Scan, rank, filter, match — SQL and
   pure functions. LLMs only ever (a) write drafts, (b) compile the idea
   brief, (c) distill learnings. NEVER an LLM router/planner — that apparatus
   was deleted on purpose (`compileServerReadOnlyPlan` replaced it).
2. **One write path.** A proactive draft, a chat draft, and a plan-item draft
   are the SAME turn pipeline (`lib/agent/chat-turn.ts` → turn/{setup,context,
   compile,execute,finalize,outcome}) with different senders. If a feature
   needs its own writer, it's wrong.
3. **New state is dumb.** New tables are status columns + payload jsonb. No
   workflow engines, no transition logic.
4. **Everything behind a workspace flag**, rolled out to the owner's workspace
   first. Each phase ships independently.
5. **Fail-open everywhere.** Any new block/step that errors must degrade to
   today's behavior (mirrors `feedbackPromise` in lib/agent/turn/context.ts).
6. **Cost ceiling:** an LLM is only invoked for a post that has survived every
   deterministic gate. Analysis is the database's job; writing is the model's
   job. Target ≤ ~$0.01–0.05/day/workspace for the whole loop.

## 3. What already exists (do NOT rebuild)

| Capability | Where |
|---|---|
| Scrape pipeline + per-creator outlier gate (top 1%, ≥20 posts) | lib/pipeline.ts, `decideTemplateOutlier` lib/viral.ts:311 |
| Per-workspace viral classification | lib/viral.ts `classifyPostForAllWorkspaces`, table `workspace_post_classification` |
| Auto-generated templates from outliers (top 1%) | lib/pipeline.ts templating phase, lib/claude.ts `templatizeOutlierPost`, table `content_templates` (source 'auto', origin_post_id) |
| Post embeddings (text-embedding-3-small) | posts.embedding, lib/pipeline-embed*, scripts/backfill-post-embeddings.ts |
| Structure skeletons of posts | lib/post-structure-skeleton.ts |
| Voice profile + backstory library | lib/claude.ts voice synthesis, lib/agent/specialists/backstory.ts |
| Feedback memory + learned preferences | lib/content-feedback.ts, lib/learned-preference.ts |
| Own-post analytics (impressions/likes/...) | lib/post-analytics.ts, table `post_analytics` |
| Performance learnings block (deterministic + LLM insights) | lib/post-performance-learning.ts |
| Grounded writer lanes + finalizer + AI-tell repair | lib/agent/execute/writer.ts, lib/agent/finalize/finalizer.ts, lib/agent/specialists/ai-tell-repair.ts |
| Live plan narration (plan_update steps) | lib/agent/execute/writer.ts (narratePlan), lib/agent/execute/agent.ts |
| Modeling source rotation: recency-first + 30-day cross-chat cooldown | lib/agent/tools.ts, lib/modeling-source-selection.ts |
| Newsjacking web/news research | lib/news-search.ts, read-only lane in lib/agent/execute/agent.ts |
| Board, scheduling, publishing | lib/draft-publishing.ts, app/(app)/dashboard/posts |
| NextActionChip on chat home | app/(app)/dashboard/chat-workspace.tsx (`CoworkNextAction`) |

## 4. Phases

Each phase = one PR, independently shippable, workspace-flagged. Order matters
(dependencies noted). Effort in engineer-days (ed).

---

### PHASE A — Structure matching engine (idea → best structure) · ~1.5ed

Today "model a top viral post" picks the freshest viral post regardless of
whether its STRUCTURE fits the idea. This phase makes idea→structure a real
matching problem and unifies templates + swipe posts into one "structure pool".

**A1. Brief compiler (new, one LLM call per user-initiated write turn)**
- New `lib/agent/idea-brief.ts`: `compileIdeaBrief(userText) → { contentType:
  "story"|"how_to"|"contrarian"|"teardown"|"announcement"|"metric", coreClaim,
  register } | null`. BACKGROUND_MODEL (z-ai/glm-5.1), strict JSON-out with
  tolerant parsing, ~8s timeout, fail-open → null (turn proceeds with
  embedding-only match). INJECTION_GUARD + untrusted wrapping per
  lib/agent/untrusted.ts. Usage logged via logOpenRouterUsage("idea_brief", …).
- Called in the read-only lane setup when a post-shaped turn has no explicit
  source attached. NEVER for proactive/analytical turns.

**A2. Embed templates at creation (migration 117)**
- `content_templates` gains `embedding vector(1536)` (same dims as posts) +
  `structure_type text` (the contentType the template's arc serves, from the
  templatize call).
- Extend `templatizeOutlierPost` (lib/claude.ts) to also return structure_type;
  embed body at insert time (reuse the posts embedding helper). Backfill
  embeddings for existing rows in scripts/backfill-outlier-templates.ts or a
  small new script (pattern: scripts/backfill-post-embeddings.ts).

**A3. `lib/structure-match.ts` (new, pure)**
- `rankStructureCandidates({ brief, ideaEmbedding, candidates, recentSkeletons,
  cooldownIds, performanceWeights }) → ranked[]`.
- Candidate = { kind: "template"|"swipe_post", id, embedding, structureType,
  provenanceScore, postedAt, text }.
- Ranking (documented weights, all pure): contentType match (brief) ×
  embedding similarity × proven-ness (template > outlier-margin > plain viral)
  × freshness × NOT in cooldown × NOT structurally similar to the user's last
  N drafts (compare lib/post-structure-skeleton.ts fingerprints) × user's own
  analytics-weighted arcs (from post-performance learnings).
- The matcher runs INSIDE the existing context builder (lib/agent/turn/context.ts)
  as another fail-open promise, result handed to the writer as the modeling
  source set.

**A4. Narration**: new plan step via the existing narratePlan contract:
"Considering N structures — picked [arc] from [template|creator]".

**Tests**: idea-brief coercion (fenced JSON, garbage → null); rankStructureCandidates
unit matrix (type match beats embedding, cooldown excludes, recent-skeleton
down-ranks, template pedigree wins ties); context builder fail-open; a
draft-engine test that the matched source reaches the writer.

---

### PHASE B — Two-draft presentation (modeled + grounded-original) · ~1ed · DROPPED

> DROPPED 2026-07-21: the two-draft UI/routing added complexity without improving
> output quality. The product stays modeled-only; learning happens continuously
> via Phase C edit-delta rules applied to modeled posts. Kept here only as a
> record of the rejected design.

Kill the original-vs-model decision for the user. Every post request produces
TWO drafts: one modeled on the top structure (Phase A), one grounded-original
(built from voice + learnings + pattern, no single source). Which card the
user saves/rates becomes structure-preference training data.

- Writer: mixed slot mode — the existing multi-draft slot engine
  (lib/agent/execute/writer.ts runLocalSlotBatch) already assigns one source
  per slot; add `mixedMode: "modeled_plus_grounded"` where slot 1 = source
  task (top structure), slot 2 = original task with learnings block. Cards
  labeled "Modeled on [source]" vs "From your patterns".
- Contract change: expectedCount 2 for these turns (within the existing 1–6
  clamp, lib/agent/turn/count.ts).
- Behind flag `agent_two_draft` (workspace settings KV). Fallback when no
  structure matches: single grounded-original (no dead-end).
- Selection analytics: record which card was saved/rated into feedback memory
  (extend content_feedback payload with `competed_against` artifact id) —
  feeds Phase A's `performanceWeights` over time.

**Tests**: mixed-mode slot assignment; narration shows both steps; fallback to
single draft when pool empty; selection recorded on save.

---

### PHASE C — Edit-delta learning (the voice compounds) · ~1ed

The strongest voice signal is the user's own edits to drafts. Capture and
distill them.

**C1. Capture**: on draft edit+save (both board edit and chat edit paths —
find them via `updateArtifact`/`draft-lifecycle-supabase.ts`), persist
{ artifact_id, before_body, after_body, edited_at } — new table
`draft_edit_events` (migration 118) or artifact meta if volume is tiny
(prefer the table; it's queried as a series).

**C2. Distiller** (new `lib/voice-edit-distiller.ts`, pattern copied from
lib/agent/specialists/backstory.ts): every N edits or daily cron — ONE
BACKGROUND_MODEL call over the last ≤20 diffs → ≤3 candidate preference rules
("uses contractions even in formal posts", "cuts hedging adverbs"). Strict
JSON, max 120 chars/rule, dedupe against existing preferences.

**C3. Write path**: rules land in the SAME learned-preferences store
(lib/learned-preference.ts, shown + editable in Voice settings, undo-able) —
marked `origin: "edit_delta"` so users can distinguish agent-inferred rules.
Nothing touches the core voice profile JSON (too risky); preferences layer only.

**North-star metric (instrument it here)**: median character edit-distance
between first-draft body and saved body per workspace, tracked weekly. This is
the number that should shrink as the moat compounds.

**Tests**: capture on both edit paths; distiller coercion; dedupe vs existing
prefs; rules appear in writer prompts via the existing preferences block.

---

### PHASE D — The agent loop (scan → rank → act daily) · ~2ed

**D1. Opportunities table (migration 119)**
```sql
create table if not exists agent_opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  kind text not null check (kind in ('outlier','news','pattern')),
  source_post_id uuid references posts(id) on delete set null,
  status text not null default 'proposed'
    check (status in ('proposed','drafting','drafted','dismissed','expired')),
  score numeric not null default 0,
  payload jsonb not null default '{}',   -- headline, author, metrics, reason
  drafted_artifact_id uuid references chat_artifacts(id) on delete set null,
  created_at timestamptz not null default now(),
  acted_at timestamptz
);
-- unique partial index: one live opportunity per (workspace_id, source_post_id)
```
RLS mirrors chats/workspace tables (see migration-036 pattern).

**D2. Scanner+ranker (`lib/agent-loop/scan.ts`, pure + SQL)**
- Per workspace (default-on; scanner no-ops when no creators are tracked):
  fresh outliers (posted_at < 72h, top-1% gate already stamped at ingest),
  news hooks (reuse news-search deterministically: last-14d, topic overlap
  with user niches), pattern gaps (pattern brief + days since user's last
  post).
- Rank = freshness × nicheOverlap × dismissalHistory(−) × cooldown(−) — all
  pure. Top 3 kept as `proposed`; older than 5 days → `expired`.

**D3. Actor (cron, extends app/api/cron/daily/route.ts)**
- For the top 1–2 opportunities (hard cap, env `AGENT_DAILY_DRAFT_CAP=2`):
  run a PROACTIVE turn = the existing chat pipeline invoked server-side into a
  per-workspace system chat titled "Your agent" (created lazily; proactive
  drafts appear there AND on the board — one surface, per the vision).
- The turn's instruction is compiled from the opportunity payload; the source
  is attached explicitly (full provenance, source chip, fidelity gate).
- status: proposed → drafting → drafted (drafted_artifact_id set). Failure →
  proposed stays, retried next run once, then expired. Fail-open per workspace.

**D4. Proposals cost zero LLM**: headline strings are templated from payload
("Creator X went 10× — 'first 80 chars of post…' — draft it?").

**Tests**: scanner ranking matrix; cap enforcement; idempotent daily run (no
dupes via the unique index); proactive turn produces a normal artifact with
source chip; failure leaves the opportunity retryable.

---

### PHASE E — "While you were away" home surface · ~1.5ed

**E1. Briefing API** `GET /api/agent/briefing`: drafted-but-unreviewed agent
drafts + proposed opportunities (from agent_opportunities), plus the NextAction
payload. Fail-open → null, UI falls back to today's empty state.

**E2. Home rework** (app/(app)/dashboard/chat-workspace.tsx — EXTRACT the
empty state into its own component file first; the file is ~7.7k lines, do not
grow it): "While you were away" section above the composer — draft cards
(review/edit/schedule in place) + proposal rows with "Draft it" (→ normal
grounded turn with the source attached) and "Not relevant" (→ dismissed,
trains ranker). Starters demote into the existing "Browse more workflows"
collapsible.

**E3. Board badge**: `meta.suggested_by = "agent"` on proactive artifacts →
"Suggested" filter/badge on the Posts board (no migration; meta is jsonb).

**E4. Breakout radar**: extend the NextActionChip data source with the freshest
fresh outlier ("Creator X went 10× 3h ago — model it while it's hot") —
computed from already-scraped data, no LLM. Click → grounded turn.

**Tests**: briefing API shape + fail-open; section hidden when empty;
"Draft it" launches a turn with provenance; dismissal flips status and
down-ranks future scans.

---

### PHASE F — Plan-my-week (ephemeral planner) · ~1ed

NOT a persistent planner (that was the rejected design — staleness + auto-
execution complexity). "Plan my week" is a chat command that generates a FRESH
plan on demand from that moment's signals (fresh outliers, learnings, days
since last post), rendered as the existing plan-checklist artifact. Each item
has "Draft this" → a normal grounded turn. No new tables, no cron.

**Tests**: plan derives from live signals; item launches grounded turn; plan
regenerates fresh next time.

---

## 5. Migrations (run manually in Supabase, in order)

Latest applied: **116** (template-outlier-autogen). Apply each phase's
migration only when that phase ships.

**Migration 117 — template embeddings (Phase A)**
```sql
begin;
alter table public.content_templates
  add column if not exists embedding vector(1536),
  add column if not exists structure_type text;
insert into public.app_schema_version (singleton, version, updated_at)
values (true, 117, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
commit;
```

**Migration 118 — draft edit events (Phase C)**
```sql
begin;
create table if not exists public.draft_edit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  artifact_id uuid not null references chat_artifacts(id) on delete cascade,
  before_body text not null,
  after_body text not null,
  created_at timestamptz not null default now()
);
create index if not exists draft_edit_events_ws_idx
  on public.draft_edit_events (workspace_id, created_at desc);
alter table public.draft_edit_events enable row level security;
create policy draft_edit_events_isolation on public.draft_edit_events
  using (workspace_id = auth_workspace_id());
alter table public.content_preferences
  drop constraint if exists content_preferences_source_check;
alter table public.content_preferences
  add constraint content_preferences_source_check
  check (source in ('user', 'learned', 'edit_delta'));
insert into public.app_schema_version (singleton, version, updated_at)
values (true, 118, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
commit;
```

**Migration 119 — agent opportunities (Phase D)**: full SQL in §4.D1 plus:
```sql
create unique index if not exists agent_opportunities_live_source_idx
  on public.agent_opportunities (workspace_id, source_post_id)
  where status in ('proposed','drafting');
alter table public.agent_opportunities enable row level security;
create policy agent_opportunities_isolation on public.agent_opportunities
  using (workspace_id = auth_workspace_id());
-- + app_schema_version bump to 119 (same upsert shape as above)
```
After each migration file lands, run `npm run migrations:metadata` and
`npm run migrations:check` in the repo.

## 6. Validation plan (metrics per phase)

- **Phase A/B**: structure-pick rate (how often the modeled card is
  saved/rated over the grounded one); Good/Needs-work ratio vs the
  single-draft baseline on the flagged workspace.
- **Phase C**: median edit-distance per draft, weekly trend (should shrink);
  % of distilled rules the user keeps vs deletes.
- **Phase D/E**: proposal click-through ("Draft it" rate), draft approval rate,
  dismissal rate (must fall over time as the ranker learns).
- **Phase F**: item "Draft this" click-through.

If pick/click rates are low after 2 weeks on the owner's workspace, do NOT
roll to all users — tune the ranker first.

## 7. Rollout order & flags

A → C → D/E → F (B dropped). All shipped features are default-on; no workspace
flags remain (`agent_structure_match` and `agent_loop` shipped default-on;
`agent_two_draft` was dropped). Cost is bounded by per-run caps
(`AGENT_DAILY_DRAFT_CAP`, workspaces-per-cron) instead of flags.

## 8. Handoff notes for the executing harness

**Repo truths you must respect:**
- Tests: vitest. Targeted: `npx vitest run evals/data/<file>.test.ts`. Full
  suite (REQUIRED before every PR): `npm run test:evals` (~3,700 tests, ~25s).
  Typecheck: `npx tsc --noEmit`. Lint: `npx eslint <files>`.
- Tests live in evals/data/*.test.ts; big integration scenarios use
  evals/cowork-outcome-harness.ts (production-shaped fake supabase + scripted
  model adapters). Mirror existing tests' style.
- Migrations are applied MANUALLY in Supabase by the owner. Every migration
  needs: the .sql file in db/, a contract test in evals/data/migration-*-
  contract.test.ts, `npm run migrations:metadata` + `npm run migrations:check`.
- Scripts (backfills etc.) require Node ≥22 (supabase-js realtime). The system
  default Node is 20; run with
  `PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$PATH" npx tsx --env-file=.env.local scripts/<name>.ts`.
- `.env.local` (never print it) provides NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY. The OpenRouter key has a
  total spend limit — 403 "Key limit exceeded" means top it up.
- PR flow: branch from main, `gh pr create --base main`. Do NOT commit to
  main directly. No git mutations beyond branch/commit/push without asking.
- Comment style: dense "why" comments for non-obvious decisions, matching
  neighboring files. Keep diffs minimal and scoped.
- chat-workspace.tsx is ~7.7k lines — extract components rather than grow it.
- `app_schema_version` bumps ride inside each migration (upsert on singleton).

**Model/cost context (July 2026)**: CHAT_MODEL = z-ai/glm-5.2
($0.93/$3.00 per M tokens), BACKGROUND_MODEL = z-ai/glm-5.1 for jobs,
anthropic/claude-sonnet-5 as writer fallback (expensive — keep as fallback
only). Real usage data lives in `usage_events` (kind, model, tokens, cost_usd)
— query it before changing model routing.

**Known debts (do not "fix" while implementing):**
- `.worktrees/` may contain stale agent worktrees — ignore.
- `renderPatternBriefBlock` (lib/batch/pattern-brief.ts) is currently dead
  code — Phase D may wire it in; note it in that PR.
- Sameness/freshness specialists (lib/agent/specialists/) are built but
  dormant — leave dormant unless a phase explicitly says otherwise.

## 9. Decision log (already decided — do not re-litigate)

1. Autonomy is the product; Cowork (chat) stays as the steering surface. One
   surface, two directions of initiative.
2. No ungrounded drafts ever; "original" becomes "grounded-original" (voice +
   learnings + patterns, no single source).
3. No LLM routing/planning anywhere. Deterministic gates, LLM writes only.
4. Proposals/drafts are pull-presented ("While you were away"), never pushed
   (no notifications/emails in v1).
5. Plan-my-week is ephemeral/on-demand, NOT a persistent auto-executing plan.
6. Structure pool unifies templates + swipe posts; templates embedded; brief
   compiler is the ONLY new per-turn LLM call and only on user-initiated turns.
7. Outliers are top 1% per creator, ≥20 posts (changed from 5% — 163→66
   qualifying posts at backfill).
8. Modeling cooldown is 30 days, cross-chat, with last-resort top-up.
9. LLM analysis only on high performers (≥1.5× median), cached 7 days.
10. Review-before-publish is an absolute invariant.
