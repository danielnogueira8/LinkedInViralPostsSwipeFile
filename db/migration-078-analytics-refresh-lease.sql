-- Global lease for the API-key-wide Zernio analytics refresh.
-- One authenticated workspace action refreshes every workspace, so the
-- cooldown must be global and atomically claimed before the provider call.
create table if not exists analytics_refresh_state (
  singleton boolean primary key default true check (singleton),
  last_started_at timestamptz
);

insert into analytics_refresh_state (singleton, last_started_at)
values (true, null)
on conflict (singleton) do nothing;

alter table analytics_refresh_state enable row level security;

create or replace function claim_analytics_refresh(p_cooldown_seconds integer)
returns table (claimed boolean, retry_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_started_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_cooldown_seconds < 1 then
    raise exception 'cooldown must be positive';
  end if;

  perform pg_advisory_xact_lock(hashtext('analytics_refresh_global'));

  select last_started_at
    into v_last_started_at
    from analytics_refresh_state
    where singleton = true;

  if v_last_started_at is not null
     and v_last_started_at + make_interval(secs => p_cooldown_seconds) > v_now then
    return query select false, v_last_started_at + make_interval(secs => p_cooldown_seconds);
    return;
  end if;

  update analytics_refresh_state
     set last_started_at = v_now
   where singleton = true;

  return query select true, null::timestamptz;
end;
$$;

revoke all on analytics_refresh_state from public, anon, authenticated;
revoke all on function claim_analytics_refresh(integer) from public, anon, authenticated;
grant execute on function claim_analytics_refresh(integer) to service_role;
