-- Drop the cowork rollout health circuit-breaker tables. The feature is being
-- removed as part of the hard cut to a single deterministic turn architecture.

-- The RPC returns the table's row type, so it must go before the table drop.
drop function if exists public.record_cowork_rollout_health(text, text);

drop table if exists public.cowork_rollout_health_events;
drop table if exists public.cowork_rollout_health;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 110, now())
on conflict (singleton)
do update set version = 110, updated_at = now();
