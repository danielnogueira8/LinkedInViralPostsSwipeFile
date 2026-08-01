-- Migration 163: creator-independent Trend Radar opportunities.
--
-- Trend Radar shares the existing proposed-opportunity workflow so discovery
-- can remain separate from drafting and publishing. A trend has no source post
-- id; its grounded evidence lives in payload and is handed to the normal
-- newsjacking turn only after the user clicks Draft this.

begin;

alter table public.agent_opportunities
  add column if not exists trend_key text;

alter table public.agent_opportunities
  drop constraint if exists agent_opportunities_kind_check;

alter table public.agent_opportunities
  add constraint agent_opportunities_kind_check
  check (kind in ('outlier', 'news', 'pattern', 'trend'));

create unique index if not exists agent_opportunities_live_trend_idx
  on public.agent_opportunities (workspace_id, trend_key)
  where kind = 'trend'
    and trend_key is not null
    and status in ('proposed', 'drafting');

alter table public.chat_modeling_sources
  drop constraint if exists chat_modeling_sources_source_check;

alter table public.chat_modeling_sources
  add constraint chat_modeling_sources_source_check
  check (source in ('swipe', 'bookmark', 'draft', 'template', 'trend'));

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 163, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
