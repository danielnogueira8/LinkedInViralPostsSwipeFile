-- Atomic short-lived claims for paid AI operations that begin in request routes.
-- The durable background-job worker has its own execution lease; this table
-- prevents two concurrent HTTP requests from enqueueing the same paid work.

create table if not exists ai_operation_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  operation_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, operation_key)
);

create index if not exists ai_operation_claims_expiry_idx
  on ai_operation_claims (expires_at);

alter table ai_operation_claims enable row level security;

drop policy if exists ai_operation_claims_isolation on ai_operation_claims;
create policy ai_operation_claims_isolation on ai_operation_claims
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

create or replace function claim_ai_operation(
  p_workspace_id text,
  p_operation_key text,
  p_ttl_seconds integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id uuid;
  v_operation_key text;
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_operation_key is null or btrim(p_operation_key) = '' then
    raise exception 'operation key is required';
  end if;
  if p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'operation claim ttl must be between 1 and 3600 seconds';
  end if;

  v_operation_key := left(p_operation_key, 200);

  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id || ':' || v_operation_key, 0)
  );

  delete from ai_operation_claims
  where workspace_id = p_workspace_id
    and operation_key = v_operation_key
    and expires_at <= clock_timestamp();

  insert into ai_operation_claims (workspace_id, operation_key, expires_at)
  values (
    p_workspace_id,
    v_operation_key,
    clock_timestamp() + make_interval(secs => p_ttl_seconds)
  )
  on conflict (workspace_id, operation_key) do nothing
  returning id into v_claim_id;

  return v_claim_id;
end;
$$;

create or replace function release_ai_operation(
  p_workspace_id text,
  p_claim_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from ai_operation_claims
  where id = p_claim_id
    and workspace_id = p_workspace_id;
$$;

revoke all on ai_operation_claims from public, anon, authenticated;
revoke all on function claim_ai_operation(text, text, integer)
  from public, anon, authenticated;
revoke all on function release_ai_operation(text, uuid)
  from public, anon, authenticated;
grant execute on function claim_ai_operation(text, text, integer) to service_role;
grant execute on function release_ai_operation(text, uuid) to service_role;
