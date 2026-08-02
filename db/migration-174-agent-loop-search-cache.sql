-- Migration 174: retry daily Newsjacking synthesis without repeating paid search.

begin;

alter table public.agent_loop_daily_claims
  add column if not exists search_payload jsonb,
  add column if not exists synthesis_completed_at timestamptz,
  add column if not exists synthesis_claim_token uuid,
  add column if not exists synthesis_claimed_at timestamptz;

create or replace function public.claim_agent_loop_daily_synthesis(
  p_workspace_id text,
  p_local_date date,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed_count integer;
begin
  if nullif(btrim(p_workspace_id), '') is null
    or p_local_date is null
    or p_claim_token is null then
    raise exception 'Valid Agent loop synthesis claim input is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'agent-loop-synthesis:' || p_workspace_id || ':' || p_local_date::text,
      0
    )
  );

  update public.agent_loop_daily_claims
  set synthesis_claim_token = p_claim_token,
      synthesis_claimed_at = now()
  where workspace_id = p_workspace_id
    and local_date = p_local_date
    and search_payload is not null
    and synthesis_completed_at is null
    and synthesis_claim_token is null;

  get diagnostics claimed_count = row_count;
  return claimed_count = 1;
end;
$$;

revoke all on function public.claim_agent_loop_daily_synthesis(
  text, date, uuid
) from public, anon, authenticated;
grant execute on function public.claim_agent_loop_daily_synthesis(
  text, date, uuid
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 174, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
