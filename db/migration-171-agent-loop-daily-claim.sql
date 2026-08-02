-- Migration 171: one paid Trend Radar pass per workspace and UTC day.
--
-- The creator scan remains hourly because it must recover when the daily
-- scrape finishes late. Trend Radar is different: it invokes paid web search,
-- so the hourly wake-up needs an atomic, durable daily fence.

begin;

create table if not exists public.agent_loop_daily_claims (
  workspace_id text not null,
  local_date date not null,
  claimed_at timestamptz not null default now(),
  primary key (workspace_id, local_date)
);

alter table public.agent_loop_daily_claims enable row level security;
drop policy if exists agent_loop_daily_claims_isolation
  on public.agent_loop_daily_claims;
create policy agent_loop_daily_claims_isolation
  on public.agent_loop_daily_claims
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

create or replace function public.claim_agent_loop_daily_run(
  p_workspace_id text,
  p_local_date date
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
begin
  if nullif(btrim(p_workspace_id), '') is null or p_local_date is null then
    raise exception 'Valid Agent loop daily claim input is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'agent-loop-daily:' || p_workspace_id || ':' || p_local_date::text,
      0
    )
  );

  insert into public.agent_loop_daily_claims (workspace_id, local_date)
  values (p_workspace_id, p_local_date)
  on conflict (workspace_id, local_date) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;

revoke all on table public.agent_loop_daily_claims from public, anon, authenticated;
grant all on table public.agent_loop_daily_claims to service_role;
revoke all on function public.claim_agent_loop_daily_run(text, date)
  from public, anon, authenticated;
grant execute on function public.claim_agent_loop_daily_run(text, date)
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 171, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
