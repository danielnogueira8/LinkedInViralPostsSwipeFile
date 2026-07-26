-- Migration 139: service-only read seam for independent discovery minimums.
begin;

create or replace function public.get_discovery_thresholds(
  p_workspace_id text
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select setting.value
      from public.settings setting
      where setting.workspace_id = p_workspace_id
        and setting.key = 'discovery_thresholds'
    ),
    '{
      "regular": {"enabled": true, "minLikes": 100},
      "leadMagnet": {"enabled": true, "minComments": 250}
    }'::jsonb
  )
$$;

revoke all on function public.get_discovery_thresholds(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_discovery_thresholds(text) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 139, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
