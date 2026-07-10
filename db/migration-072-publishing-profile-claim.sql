-- Migration 072: Serialize first-time Zernio profile creation per workspace.

alter table publishing_connections
  add column if not exists profile_claim_token uuid;

alter table publishing_connections
  add column if not exists profile_claimed_at timestamptz;

create or replace function claim_publishing_profile(p_workspace_id text)
returns table(profile_id text, claim_token uuid, acquired boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id text;
  v_claim_token uuid;
  v_claimed_at timestamptz;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('publishing-profile:' || p_workspace_id, 0)
  );

  select zernio_profile_id, profile_claim_token, profile_claimed_at
  into v_profile_id, v_claim_token, v_claimed_at
  from publishing_connections
  where workspace_id = p_workspace_id
    and network = 'linkedin';

  if v_profile_id is not null then
    return query select v_profile_id, null::uuid, false;
    return;
  end if;

  if v_claim_token is not null
    and v_claimed_at >= now() - interval '2 minutes' then
    return query select null::text, null::uuid, false;
    return;
  end if;

  v_claim_token := gen_random_uuid();

  insert into publishing_connections (
    workspace_id,
    network,
    status,
    disconnected_reason,
    profile_claim_token,
    profile_claimed_at,
    updated_at
  )
  values (
    p_workspace_id,
    'linkedin',
    'disconnected',
    'Connection setup in progress',
    v_claim_token,
    now(),
    now()
  )
  on conflict (workspace_id, network) do update
  set profile_claim_token = excluded.profile_claim_token,
      profile_claimed_at = excluded.profile_claimed_at,
      updated_at = excluded.updated_at;

  return query select null::text, v_claim_token, true;
end;
$$;

revoke all on function claim_publishing_profile(text) from public;
revoke all on function claim_publishing_profile(text) from anon;
revoke all on function claim_publishing_profile(text) from authenticated;
grant execute on function claim_publishing_profile(text) to service_role;
