-- Migration 172: split external Newsjacking from creator-cluster Trend Radar.
--
-- Migration 163 used kind='trend' for the web-backed scanner. Those rows are
-- historical Newsjacking opportunities; new creator-cluster opportunities
-- will keep kind='trend'. Preserve their lifecycle and evidence while moving
-- only the discriminator used by the read/action paths.

begin;

update public.agent_opportunities
set kind = 'news'
where kind = 'trend';

create unique index if not exists agent_opportunities_live_news_idx
  on public.agent_opportunities (workspace_id, trend_key)
  where kind = 'news'
    and trend_key is not null
    and status in ('proposed', 'drafting');

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 172, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
