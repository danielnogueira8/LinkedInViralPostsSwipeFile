-- Migration 173: classify any remaining legacy web-backed opportunities.
--
-- Migration 172 covered the historical payload markers emitted by the old
-- scanner. This catches older/manual rows that still carry the old scanner's
-- top-level source_url but lack those markers. Creator-cluster Trend Radar
-- payloads do not use a top-level source_url.

begin;

update public.agent_opportunities
set kind = 'news'
where kind = 'trend'
  and payload->>'source_url' is not null
  and payload->>'signal_type' is distinct from 'trend_radar';

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 173, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
