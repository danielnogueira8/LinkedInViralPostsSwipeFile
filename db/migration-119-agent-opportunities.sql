-- Migration 119: agent opportunities (PLAN-agent-loop Phase D1).
--
-- The daily scanner writes proposed opportunities here. The actor turns the top
-- ones into drafts. Status is deliberately dumb: proposed → drafting → drafted,
-- or dismissed/expired. The unique partial index guarantees one live
-- opportunity per (workspace, source post).

begin;

create table if not exists public.agent_opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  kind text not null check (kind in ('outlier','news','pattern')),
  source_post_id uuid references posts(id) on delete set null,
  status text not null default 'proposed'
    check (status in ('proposed','drafting','drafted','dismissed','expired')),
  score numeric not null default 0,
  payload jsonb not null default '{}',
  drafted_artifact_id uuid references chat_artifacts(id) on delete set null,
  created_at timestamptz not null default now(),
  acted_at timestamptz
);

create unique index if not exists agent_opportunities_live_source_idx
  on public.agent_opportunities (workspace_id, source_post_id)
  where status in ('proposed','drafting');

create index if not exists agent_opportunities_ws_status_idx
  on public.agent_opportunities (workspace_id, status, score desc);

alter table public.agent_opportunities enable row level security;

create policy agent_opportunities_isolation on public.agent_opportunities
  using (workspace_id = auth_workspace_id());

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 119, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
