-- Atomically recover a missed midnight global scrape. The table lock keeps the
-- completed-today check consistent with pipeline terminal updates; the advisory
-- lock shares the same global claim boundary as claim_scrape_run.
create or replace function claim_daily_scrape_recovery(
  p_day_start timestamptz,
  p_stale_before timestamptz
)
returns table(run_id uuid, created boolean, completed_today boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_created boolean;
begin
  -- Match claim_scrape_run's lock order so the midnight claim and recovery
  -- cannot deadlock when they overlap.
  perform pg_advisory_xact_lock(hashtextextended('__global__', 0));
  lock table runs in share row exclusive mode;

  select id into v_run_id
  from runs
  where status = 'ok'
    and workspace_id is null
    and started_at >= p_day_start
    and started_at < p_day_start + interval '1 day'
  order by started_at desc
  limit 1;

  if v_run_id is not null then
    return query select v_run_id, false, true;
    return;
  end if;

  -- Reuse the canonical stale/active/new claim state machine. Its advisory
  -- lock is re-entrant in this transaction; the table lock above keeps the
  -- completed check atomic with terminal pipeline writes.
  select claim.run_id, claim.created
  into v_run_id, v_created
  from claim_scrape_run(null::text, p_stale_before) as claim;

  return query select v_run_id, v_created, false;
end;
$$;

revoke all on function claim_daily_scrape_recovery(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function claim_daily_scrape_recovery(timestamptz, timestamptz)
  to service_role;
