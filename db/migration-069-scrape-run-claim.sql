create or replace function claim_scrape_run(
  p_workspace_id text,
  p_stale_before timestamptz
)
returns table(run_id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_workspace_id, '__global__'), 0));

  update runs
  set status = 'error',
      phase = 'error',
      phase_msg = 'Stale scrape run replaced.',
      error = 'stuck: replaced by a new scrape claim',
      finished_at = now()
  where status = 'running'
    and workspace_id is not distinct from p_workspace_id
    and started_at < p_stale_before;

  select id into v_run_id
  from runs
  where status = 'running'
    and workspace_id is not distinct from p_workspace_id
  order by started_at desc
  limit 1;

  if v_run_id is not null then
    return query select v_run_id, false;
    return;
  end if;

  insert into runs (workspace_id, status, phase, phase_msg, progress, posts_count, viral_count)
  values (p_workspace_id, 'running', 'scraping', 'Queued. We''ll start as soon as capacity opens.', '[]'::jsonb, 0, 0)
  returning id into v_run_id;

  return query select v_run_id, true;
end;
$$;

revoke all on function claim_scrape_run(text, timestamptz) from public, anon, authenticated;
grant execute on function claim_scrape_run(text, timestamptz) to service_role;
