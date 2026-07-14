-- One workspace-wide reservation ledger for every paid AI operation. This is
-- deliberately shared across operation types: a chat turn and lead-magnet
-- generation racing near the budget must observe each other's reservation.

create table if not exists workspace_cost_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  operation_key text not null,
  estimated_cost_usd numeric not null check (estimated_cost_usd > 0),
  release_blocked boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, operation_key)
);

create index if not exists workspace_cost_claims_expiry_idx
  on workspace_cost_claims (expires_at);

alter table workspace_cost_claims enable row level security;
drop policy if exists workspace_cost_claims_isolation on workspace_cost_claims;
create policy workspace_cost_claims_isolation on workspace_cost_claims
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

alter table chats add column if not exists turn_cost_operation_key text;

create or replace function claim_workspace_cost(
  p_workspace_id text,
  p_operation_key text,
  p_estimated_cost_usd numeric,
  p_budget_usd numeric,
  p_ttl_seconds integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_committed numeric;
  v_reserved numeric;
  v_claim_id uuid;
  v_release_blocked boolean;
  v_operation_key text := left(p_operation_key, 200);
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'Workspace id is required';
  end if;
  if v_operation_key is null or btrim(v_operation_key) = '' then
    raise exception 'Operation key is required';
  end if;
  if p_budget_usd <= 0 or p_estimated_cost_usd <= 0 then
    raise exception 'Cost budget and estimate must be positive';
  end if;
  if p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'Cost claim ttl must be between 1 and 3600 seconds';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('workspace-ai-cost:' || p_workspace_id, 0));

  delete from workspace_cost_claims
  where workspace_id = p_workspace_id
    and expires_at <= clock_timestamp();

  -- Idempotent replay of the same operation never reserves twice.
  select id, release_blocked into v_claim_id, v_release_blocked
  from workspace_cost_claims
  where workspace_id = p_workspace_id
    and operation_key = v_operation_key;
  if v_claim_id is not null then
    if v_release_blocked then return null; end if;
    return v_claim_id;
  end if;

  select coalesce(sum(cost_usd), 0) into v_committed
  from usage_events
  where workspace_id = p_workspace_id
    and ts >= v_month_start;

  select coalesce(sum(estimated_cost_usd), 0) into v_reserved
  from workspace_cost_claims
  where workspace_id = p_workspace_id
    and expires_at > clock_timestamp();

  if v_committed + v_reserved + p_estimated_cost_usd > p_budget_usd then
    return null;
  end if;

  insert into workspace_cost_claims (
    workspace_id, operation_key, estimated_cost_usd, expires_at
  ) values (
    p_workspace_id,
    v_operation_key,
    p_estimated_cost_usd,
    clock_timestamp() + make_interval(secs => p_ttl_seconds)
  ) returning id into v_claim_id;
  return v_claim_id;
end;
$$;

create or replace function release_workspace_cost(
  p_workspace_id text,
  p_operation_key text
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from workspace_cost_claims
  where workspace_id = p_workspace_id
    and operation_key = left(p_operation_key, 200)
    and release_blocked = false;
$$;

create or replace function hold_workspace_cost_claims(p_workspace_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update workspace_cost_claims
  set release_blocked = true
  where workspace_id = p_workspace_id
    and expires_at > clock_timestamp();
$$;

-- Preserve the existing count/turn implementation as an internal function,
-- then wrap it with the shared cost claim in the SAME transaction.
--
-- Idempotent rename: only rename the original claim_chat_turn to the internal
-- name if it hasn't been renamed already (a partial/second apply must not error
-- on "function does not exist"). We detect by signature: the original public
-- claim_chat_turn takes 9 args; after this migration the public wrapper also
-- takes 9 args but the *internal* one exists. Guard on the internal name's
-- absence so the rename runs exactly once.
do $$
begin
  if not exists (
    select 1 from pg_proc where proname = 'claim_chat_turn_without_workspace_cost'
  ) then
    alter function claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric)
      rename to claim_chat_turn_without_workspace_cost;
  end if;
end $$;

-- Drop-then-create (not a bare create) so a re-run replaces the wrapper cleanly
-- instead of erroring on "function already exists".
drop function if exists claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric);
create function claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_hourly_limit int,
  p_daily_limit int,
  p_monthly_limit int default 2147483647,
  p_turn_timeout_secs int default 330,
  p_budget_usd numeric default 0,
  p_turn_cost_estimate numeric default 0.05
)
returns table (allowed boolean, reason text, operation_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cost_claim uuid;
  v_allowed boolean;
  v_reason text;
  v_operation_key text := 'chat:' || p_chat_id::text || ':' || gen_random_uuid()::text;
begin
  if p_budget_usd > 0 then
    v_cost_claim := claim_workspace_cost(
      p_workspace_id,
      v_operation_key,
      p_turn_cost_estimate,
      p_budget_usd,
      p_turn_timeout_secs
    );
    if v_cost_claim is null then
      return query select false, 'monthly'::text, null::text;
      return;
    end if;
  end if;

  select verdict.allowed, verdict.reason
  into v_allowed, v_reason
  from claim_chat_turn_without_workspace_cost(
    p_workspace_id,
    p_chat_id,
    p_content,
    p_hourly_limit,
    p_daily_limit,
    p_monthly_limit,
    p_turn_timeout_secs,
    0,
    p_turn_cost_estimate
  ) as verdict;

  if not coalesce(v_allowed, false) and v_cost_claim is not null then
    perform release_workspace_cost(p_workspace_id, v_operation_key);
  elsif coalesce(v_allowed, false) then
    update chats
    set turn_cost_operation_key = v_operation_key
    where id = p_chat_id and workspace_id = p_workspace_id;
  end if;
  return query select coalesce(v_allowed, false), v_reason,
    case when coalesce(v_allowed, false) then v_operation_key else null end;
end;
$$;

create or replace function release_chat_turn_workspace_cost(
  p_workspace_id text,
  p_chat_id uuid,
  p_operation_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation_key text;
begin
  if p_operation_key is null or btrim(p_operation_key) = '' then
    return;
  end if;

  select turn_cost_operation_key into v_operation_key
  from chats
  where id = p_chat_id
    and workspace_id = p_workspace_id
    and turn_cost_operation_key = p_operation_key
  for update;

  if not found then
    return;
  end if;

  update chats
  set turn_started_at = null,
      turn_cost_operation_key = null
  where id = p_chat_id
    and workspace_id = p_workspace_id
    and turn_cost_operation_key = p_operation_key;

  if v_operation_key is not null then
    perform release_workspace_cost(p_workspace_id, v_operation_key);
  end if;
end;
$$;

revoke all on workspace_cost_claims from public, anon, authenticated;
revoke all on function claim_workspace_cost(text, text, numeric, numeric, integer)
  from public, anon, authenticated;
revoke all on function release_workspace_cost(text, text)
  from public, anon, authenticated;
revoke all on function hold_workspace_cost_claims(text)
  from public, anon, authenticated;
revoke all on function claim_chat_turn_without_workspace_cost(text, uuid, text, integer, integer, integer, integer, numeric, numeric)
  from public, anon, authenticated;
revoke all on function claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric)
  from public, anon, authenticated;
revoke all on function release_chat_turn_workspace_cost(text, uuid, text)
  from public, anon, authenticated;
grant execute on function claim_workspace_cost(text, text, numeric, numeric, integer) to service_role;
grant execute on function release_workspace_cost(text, text) to service_role;
grant execute on function hold_workspace_cost_claims(text) to service_role;
grant execute on function claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric) to service_role;
grant execute on function release_chat_turn_workspace_cost(text, uuid, text) to service_role;
