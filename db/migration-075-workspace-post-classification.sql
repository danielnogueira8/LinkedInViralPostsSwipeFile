-- Per-workspace viral classification (foundation).
--
-- PROBLEM: posts.is_viral is a GLOBAL column. Two workspaces tracking the
-- same creator (common — onboarding offers a shared category catalog, see
-- migration-011's workspace_accounts design) share posts rows, so whichever
-- workspace last saved its viral thresholds (app/api/settings/route.ts POST)
-- determines is_viral for EVERY other workspace tracking that creator. This
-- table lets classification become per-workspace without duplicating the
-- (workspace-independent) viral_score/baseline_score math on posts itself.
--
-- This migration is FOUNDATION ONLY: schema + backfill + a dual-write path.
-- Existing reads (Swipe File, agent tools, MCP tools x2, weekly batch,
-- insights) keep reading posts.is_viral in this PR — flipped to read this
-- table in a follow-up PR, one surface at a time, once the dual-write has
-- run in production and the two columns are known to agree.
create table if not exists workspace_post_classification (
  workspace_id text not null,
  post_id uuid not null references posts(id) on delete cascade,
  is_viral boolean not null,
  viral_basis text,
  computed_at timestamptz not null default now(),
  primary key (workspace_id, post_id)
);

create index if not exists workspace_post_classification_workspace_idx
  on workspace_post_classification(workspace_id);
create index if not exists workspace_post_classification_viral_idx
  on workspace_post_classification(workspace_id, post_id)
  where is_viral = true;

alter table workspace_post_classification enable row level security;
drop policy if exists workspace_post_classification_isolation on workspace_post_classification;
create policy workspace_post_classification_isolation on workspace_post_classification
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

-- Backfill: for every (workspace, tracked account) pair, classify that
-- workspace's own tracked posts using ITS OWN saved viral_thresholds (falls
-- back to the same 50/50 default lib/viral.ts uses when a workspace has never
-- saved settings). Idempotent — safe to re-run; a later run's numbers only
-- change if the workspace's own thresholds changed since the last run.
insert into workspace_post_classification (workspace_id, post_id, is_viral, viral_basis, computed_at)
select
  wa.workspace_id,
  p.id,
  (coalesce(p.reactions, 0) >= coalesce((t.value->>'min_reactions')::int, 50)
    or coalesce(p.comments, 0) >= coalesce((t.value->>'min_comments')::int, 50)) as is_viral,
  'backfill_flat_threshold' as viral_basis,
  now()
from workspace_accounts wa
join posts p on p.account_id = wa.account_id
left join settings t
  on t.workspace_id = wa.workspace_id
  and t.key = 'viral_thresholds'
on conflict (workspace_id, post_id) do update
  set is_viral = excluded.is_viral,
      viral_basis = excluded.viral_basis,
      computed_at = excluded.computed_at;
