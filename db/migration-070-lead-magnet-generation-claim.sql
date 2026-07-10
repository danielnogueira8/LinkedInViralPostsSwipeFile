-- Migration 070: Atomic monthly AI lead-magnet reservations

create table if not exists lead_magnet_generation_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  user_id text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'completed', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lead_magnet_generation_claims_active_idx
  on lead_magnet_generation_claims (user_id, created_at)
  where status = 'reserved';

alter table lead_magnet_generation_claims enable row level security;

drop policy if exists lead_magnet_generation_claims_isolation
  on lead_magnet_generation_claims;
create policy lead_magnet_generation_claims_isolation
  on lead_magnet_generation_claims
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

create or replace function claim_lead_magnet_generation(
  p_workspace_id text,
  p_user_id text,
  p_limit integer
)
returns table (claim_id uuid, used_before integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_used integer;
  v_claim_id uuid;
begin
  if p_limit < 1 then
    raise exception 'Generation limit must be positive';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lead-magnet:' || p_user_id, 0));

  update lead_magnet_generation_claims
  set status = 'released', updated_at = now()
  where user_id = p_user_id
    and status = 'reserved'
    and created_at < now() - interval '15 minutes';

  select
    (select count(*) from lead_magnets
      where user_id = p_user_id
        and source_type = 'ai'
        and created_at >= v_month_start)
    +
    (select count(*) from lead_magnet_generation_claims
      where user_id = p_user_id
        and status = 'reserved'
        and created_at >= v_month_start)
  into v_used;

  if v_used >= p_limit then
    return;
  end if;

  insert into lead_magnet_generation_claims (workspace_id, user_id)
  values (p_workspace_id, p_user_id)
  returning id into v_claim_id;

  return query select v_claim_id, v_used;
end;
$$;

revoke all on function claim_lead_magnet_generation(text, text, integer) from public;
revoke all on function claim_lead_magnet_generation(text, text, integer) from anon;
revoke all on function claim_lead_magnet_generation(text, text, integer) from authenticated;
grant execute on function claim_lead_magnet_generation(text, text, integer) to service_role;
