-- Migration 144: grace overshoot on the monthly cost cap.
--
-- Before this migration the atomic claim blocked any turn whose reservation
-- tipped the workspace past the budget (v_committed + v_reserved + estimate >
-- p_budget_usd). Because reservations are deliberately conservative, a user
-- visibly under the 1000-credit allowance (e.g. 979/1000 on the pill) could be
-- told their allowance was "used up" — the cap cut off too early.
--
-- New policy, enforced atomically here and mirrored in the app
-- (hasCostAllowanceForEstimate, lib/agent/rate-limit.ts):
--
--   1. A workspace AT/OVER the budget (committed + reserved >= budget) starts
--      no new AI work.
--   2. A workspace still UNDER the budget may finish the request it is on,
--      even when the reservation tips it past the budget, up to p_grace_usd
--      of overshoot (the app passes ~50 pill-credits' worth).
--
-- All three touched functions gain a trailing p_grace_usd parameter WITH A
-- DEFAULT, so the previous calling conventions keep working: old app code
-- against this schema behaves exactly as before (grace 0). New app code
-- against the OLD schema fails closed (unknown-parameter RPC error surfaces
-- as claim_error, never as a rate-limit), so APPLY THIS MIGRATION BEFORE
-- DEPLOYING the app change (docs/migrations.md default order).
--
-- The claim_chat_turn chain being replaced (both overloads delegate down):
--   • claim_chat_turn(text,uuid,text,integer,…,numeric,numeric) — migration
--     085 cost-claiming core (9 args)
--   • claim_chat_turn(text,uuid,text,uuid,integer,…,numeric,numeric) —
--     migration 095 client-identity wrapper (10 args, p_client_turn_id 4th)
--
-- Drop-then-create (not create-or-replace) because Postgres cannot add a
-- parameter to an existing function; drops also clear grants, so the
-- revoke/grant block at the bottom re-establishes them.

begin;

drop function if exists public.claim_workspace_cost(text, text, numeric, numeric, integer);
create function public.claim_workspace_cost(
  p_workspace_id text,
  p_operation_key text,
  p_estimated_cost_usd numeric,
  p_budget_usd numeric,
  p_ttl_seconds integer,
  p_grace_usd numeric default 0
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
  if p_grace_usd < 0 then
    raise exception 'Cost grace must not be negative';
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

  -- Already at/over the monthly cap: no new AI work, grace or not.
  if v_committed + v_reserved >= p_budget_usd then
    return null;
  end if;

  -- Under the cap: allow the operation through even when its reservation tips
  -- the workspace past the budget, as long as the overshoot fits in grace.
  if v_committed + v_reserved + p_estimated_cost_usd > p_budget_usd + p_grace_usd then
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

-- The 095 wrapper delegates to the 085 core by calling it with nine args;
-- drop the wrapper first so the core's drop can't leave a dangling caller,
-- then recreate both with the grace parameter.
drop function if exists public.claim_chat_turn(text, uuid, text, uuid, integer, integer, integer, integer, numeric, numeric);
drop function if exists public.claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric);

create function public.claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_hourly_limit int,
  p_daily_limit int,
  p_monthly_limit int default 2147483647,
  p_turn_timeout_secs int default 330,
  p_budget_usd numeric default 0,
  p_turn_cost_estimate numeric default 0.05,
  p_grace_usd numeric default 0
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
      p_turn_timeout_secs,
      p_grace_usd
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

-- Migration 095's client-identity wrapper, unchanged except for the extra
-- trailing p_grace_usd it forwards to the core above.
create function public.claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_client_turn_id uuid,
  p_hourly_limit integer,
  p_daily_limit integer,
  p_monthly_limit integer default 2147483647,
  p_turn_timeout_secs integer default 330,
  p_budget_usd numeric default 0,
  p_turn_cost_estimate numeric default 0.05,
  p_grace_usd numeric default 0
)
returns table (allowed boolean, reason text, operation_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed boolean;
  v_reason text;
  v_operation_key text;
begin
  select verdict.allowed, verdict.reason, verdict.operation_key
  into v_allowed, v_reason, v_operation_key
  from public.claim_chat_turn(
    p_workspace_id,
    p_chat_id,
    p_content,
    p_hourly_limit,
    p_daily_limit,
    p_monthly_limit,
    p_turn_timeout_secs,
    p_budget_usd,
    p_turn_cost_estimate,
    p_grace_usd
  ) as verdict;

  if coalesce(v_allowed, false) then
    update public.chats as chat
    set client_turn_id = p_client_turn_id
    where chat.id = p_chat_id
      and chat.workspace_id = p_workspace_id
      and chat.turn_cost_operation_key = v_operation_key
      and chat.turn_started_at is not null;

    update public.chat_messages as message
    set client_turn_id = p_client_turn_id
    where message.id = (
      select claimed.id
      from public.chat_messages as claimed
      where claimed.chat_id = p_chat_id
        and claimed.workspace_id = p_workspace_id
        and claimed.role = 'user'
      order by claimed.created_at desc, claimed.id desc
      limit 1
    );
  end if;

  return query select coalesce(v_allowed, false), v_reason, v_operation_key;
end;
$$;

-- Deployment readiness: the pre-144 fingerprint asserts the OLD signatures via
-- to_regprocedure, which matches identity arguments exactly and therefore goes
-- null once the grace parameter exists. Wrap it (same rename pattern as
-- migration 107), filter the stale entries out of its missing list, and
-- assert the new signatures plus their grants instead.
do $$
begin
  if to_regprocedure('public.app_deployment_readiness_pre_144()') is null then
    execute 'alter function public.app_deployment_readiness() rename to app_deployment_readiness_pre_144';
  end if;
end;
$$;

revoke all on function public.app_deployment_readiness_pre_144()
  from public, anon, authenticated, service_role;

create or replace function public.app_deployment_readiness()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  with base as (
    select public.app_deployment_readiness_pre_144() as value
  ), stale_entries(name) as (
    values
      ('claim_workspace_cost(text,text,numeric,numeric,integer)'),
      ('claim_chat_turn(text,uuid,text,integer,integer,integer,integer,numeric,numeric)')
  ), base_missing(name) as (
    select existing.value
    from base,
      lateral jsonb_array_elements_text(
        coalesce(base.value -> 'missing_capabilities', '[]'::jsonb)
      ) as existing(value)
    where existing.value not in (select name from stale_entries)
  ), required_functions(signature) as (
    values
      ('claim_workspace_cost(text,text,numeric,numeric,integer,numeric)'),
      ('claim_chat_turn(text,uuid,text,integer,integer,integer,integer,numeric,numeric,numeric)'),
      ('claim_chat_turn(text,uuid,text,uuid,integer,integer,integer,integer,numeric,numeric,numeric)')
  ), missing_functions(name) as (
    select signature
    from required_functions
    where to_regprocedure('public.' || signature) is null
  ), missing_service_execute(name) as (
    select signature || '(service_role execute)'
    from required_functions
    where not coalesce(
      has_function_privilege(
        'service_role',
        to_regprocedure('public.' || signature),
        'execute'
      ),
      false
    )
  ), unsafe_function_execute(name) as (
    select signature || '(public/anon/authenticated execute denied)'
    from required_functions
    where coalesce(
      has_function_privilege(
        'public',
        to_regprocedure('public.' || signature),
        'execute'
      ),
      false
    )
      or coalesce(
        has_function_privilege(
          'anon',
          to_regprocedure('public.' || signature),
          'execute'
        ),
        false
      )
      or coalesce(
        has_function_privilege(
          'authenticated',
          to_regprocedure('public.' || signature),
          'execute'
        ),
        false
      )
  ), new_missing(name) as (
    select name from missing_functions
    union all select name from missing_service_execute
    union all select name from unsafe_function_execute
  ), all_missing(name) as (
    select name from base_missing
    union all select name from new_missing
  )
  select jsonb_build_object(
    'applied_version', coalesce(
      (select version from public.app_schema_version where singleton),
      0
    ),
    'compatible', not exists (select 1 from all_missing),
    'missing_capabilities', coalesce(
      (select jsonb_agg(distinct name order by name) from all_missing),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.claim_workspace_cost(text, text, numeric, numeric, integer, numeric)
  from public, anon, authenticated;
revoke all on function public.claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.claim_chat_turn(text, uuid, text, uuid, integer, integer, integer, integer, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.app_deployment_readiness()
  from public, anon, authenticated;
grant execute on function public.claim_workspace_cost(text, text, numeric, numeric, integer, numeric)
  to service_role;
grant execute on function public.claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric, numeric)
  to service_role;
grant execute on function public.claim_chat_turn(text, uuid, text, uuid, integer, integer, integer, integer, numeric, numeric, numeric)
  to service_role;
grant execute on function public.app_deployment_readiness() to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 144, now())
on conflict (singleton) do update
set
  version = excluded.version,
  updated_at = excluded.updated_at;

commit;
