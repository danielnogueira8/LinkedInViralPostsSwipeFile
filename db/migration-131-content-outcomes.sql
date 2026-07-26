-- Migration 131: business outcomes attributed to published content.
--
-- Engagement is not revenue. These records capture explicit business evidence
-- with source, confidence, stable idempotency, and append-only corrections.

begin;

create table if not exists public.content_outcomes (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null default 1 check (schema_version = 1),
  workspace_id text not null,
  draft_id uuid not null,
  lineage_id uuid,
  kind text not null check (
    kind in (
      'qualified_conversation', 'qualified_dm', 'lead_magnet_conversion',
      'lead', 'booked_call', 'pipeline', 'revenue'
    )
  ),
  source text not null check (source in ('manual', 'leadshark')),
  external_id text check (
    external_id is null or length(btrim(external_id)) between 1 and 160
  ),
  idempotency_key text not null check (
    length(btrim(idempotency_key)) between 1 and 160
  ),
  status text not null default 'active' check (
    status in ('active', 'superseded')
  ),
  supersedes_outcome_id uuid references public.content_outcomes(id),
  confidence double precision not null check (
    confidence >= 0 and confidence <= 1
  ),
  quantity integer not null check (quantity >= 1),
  amount_minor bigint,
  currency text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  check (
    (amount_minor is null and currency is null)
    or (
      amount_minor is not null
      and currency is not null
      and amount_minor >= 0
      and currency ~ '^[A-Z]{3}$'
    )
  ),
  check (
    (source = 'manual' and external_id is null)
    or (source = 'leadshark' and nullif(btrim(external_id), '') is not null)
  ),
  check (
    supersedes_outcome_id is null
    or supersedes_outcome_id <> id
  )
);

create table if not exists public.content_outcome_corrections (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  original_outcome_id uuid not null
    references public.content_outcomes(id) on delete cascade,
  replacement_outcome_id uuid not null unique
    references public.content_outcomes(id) on delete cascade,
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  idempotency_key text not null check (
    length(btrim(idempotency_key)) between 1 and 160
  ),
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create or replace function public.validate_content_outcome_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.chat_artifacts draft
    where draft.id = new.draft_id
      and draft.workspace_id = new.workspace_id
      and (
        draft.status = 'posted'
        or draft.schedule_status = 'published'
      )
  ) then
    raise exception 'Content Outcome requires a published Workspace Draft'
      using errcode = '23503';
  end if;
  if new.lineage_id is not null and not exists (
    select 1 from public.artifact_lineage lineage
    where lineage.id = new.lineage_id
      and lineage.workspace_id = new.workspace_id
      and lineage.artifact_id = new.draft_id
  ) then
    raise exception 'Content Outcome lineage is outside the Draft'
      using errcode = '23503';
  end if;
  if new.supersedes_outcome_id is not null and not exists (
    select 1 from public.content_outcomes prior
    where prior.id = new.supersedes_outcome_id
      and prior.workspace_id = new.workspace_id
      and prior.draft_id = new.draft_id
  ) then
    raise exception 'Content Outcome replacement is outside the Draft'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists content_outcomes_validate_scope
  on public.content_outcomes;
create trigger content_outcomes_validate_scope
  before insert on public.content_outcomes
  for each row execute function public.validate_content_outcome_scope();

create or replace function public.enforce_content_outcome_write_path()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.content_outcome_operation', true), '')
      <> 'purge'
    then
      raise exception 'Content Outcome deletion requires Workspace erasure'
        using errcode = '55000';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'Content Outcomes must enter active'
        using errcode = '55000';
    end if;
    if new.supersedes_outcome_id is not null
      and coalesce(
        current_setting('app.content_outcome_operation', true),
        ''
      ) <> 'correction'
    then
      raise exception 'Content Outcome replacement requires a correction'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if coalesce(current_setting('app.content_outcome_operation', true), '')
    <> 'correction'
  then
    raise exception 'Content Outcome changes require a correction'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists content_outcomes_enforce_write_path
  on public.content_outcomes;
create trigger content_outcomes_enforce_write_path
  before insert or update or delete on public.content_outcomes
  for each row execute function public.enforce_content_outcome_write_path();

create or replace function public.reject_content_outcome_correction_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE'
    and current_setting('app.content_outcome_operation', true) = 'purge'
  then
    return old;
  end if;
  raise exception 'Content Outcome corrections are append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists content_outcome_corrections_immutable
  on public.content_outcome_corrections;
create trigger content_outcome_corrections_immutable
  before update or delete on public.content_outcome_corrections
  for each row execute function public.reject_content_outcome_correction_mutation();

create or replace function public.correct_content_outcome(
  p_workspace_id text,
  p_outcome_id uuid,
  p_expected_updated_at timestamptz,
  p_reason text,
  p_idempotency_key text,
  p_kind text,
  p_confidence double precision,
  p_quantity integer,
  p_amount_minor bigint,
  p_currency text,
  p_occurred_at timestamptz
)
returns public.content_outcomes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_outcome public.content_outcomes;
  replacement public.content_outcomes;
begin
  if nullif(btrim(p_workspace_id), '') is null
    or nullif(btrim(p_idempotency_key), '') is null
  then
    raise exception 'Workspace and idempotency key are required'
      using errcode = '22023';
  end if;

  -- Serialize the lookup itself. A concurrent retry waits here, then sees and
  -- returns the first transaction's replacement instead of failing stale.
  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id || ':' || p_idempotency_key, 0)
  );

  select * into replacement
  from public.content_outcomes outcome
  where outcome.workspace_id = p_workspace_id
    and outcome.idempotency_key = p_idempotency_key;
  if found then return replacement; end if;

  select * into current_outcome
  from public.content_outcomes outcome
  where outcome.id = p_outcome_id
    and outcome.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'Content Outcome not found' using errcode = 'P0002';
  end if;
  if current_outcome.updated_at <> p_expected_updated_at then
    raise exception 'Content Outcome changed during correction'
      using errcode = '40001';
  end if;
  if current_outcome.status <> 'active' then
    raise exception 'Only an active Content Outcome can be corrected'
      using errcode = '55000';
  end if;
  if length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception 'A correction reason is required' using errcode = '22023';
  end if;

  perform set_config('app.content_outcome_operation', 'correction', true);
  insert into public.content_outcomes (
    schema_version, workspace_id, draft_id, lineage_id, kind, source,
    external_id, idempotency_key, status, supersedes_outcome_id,
    confidence, quantity, amount_minor, currency, occurred_at
  ) values (
    current_outcome.schema_version, p_workspace_id, current_outcome.draft_id,
    current_outcome.lineage_id, p_kind, 'manual', null, p_idempotency_key,
    'active', current_outcome.id, p_confidence, p_quantity, p_amount_minor,
    upper(p_currency), p_occurred_at
  ) returning * into replacement;

  update public.content_outcomes outcome set
    status = 'superseded',
    updated_at = now()
  where outcome.id = current_outcome.id;

  insert into public.content_outcome_corrections (
    workspace_id, original_outcome_id, replacement_outcome_id,
    reason, idempotency_key
  ) values (
    p_workspace_id, current_outcome.id, replacement.id,
    btrim(p_reason), p_idempotency_key
  );

  return replacement;
end;
$$;

create or replace function public.purge_content_outcomes(p_workspace_id text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count bigint;
begin
  perform set_config('app.content_outcome_operation', 'purge', true);
  delete from public.content_outcomes outcome
  where outcome.workspace_id = p_workspace_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create index if not exists content_outcomes_draft_idx
  on public.content_outcomes (workspace_id, draft_id, occurred_at desc);
create index if not exists content_outcomes_learning_idx
  on public.content_outcomes (workspace_id, status, kind, occurred_at desc);
create index if not exists content_outcome_corrections_original_idx
  on public.content_outcome_corrections
    (workspace_id, original_outcome_id, created_at desc);

alter table public.content_outcomes enable row level security;
alter table public.content_outcome_corrections enable row level security;

revoke all on table public.content_outcomes
  from public, anon, authenticated;
revoke all on table public.content_outcome_corrections
  from public, anon, authenticated;
grant select, insert on table public.content_outcomes to service_role;
grant select on table public.content_outcome_corrections to service_role;
revoke all on function public.correct_content_outcome(
  text, uuid, timestamptz, text, text, text, double precision,
  integer, bigint, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.correct_content_outcome(
  text, uuid, timestamptz, text, text, text, double precision,
  integer, bigint, text, timestamptz
) to service_role;
revoke all on function public.purge_content_outcomes(text)
  from public, anon, authenticated;
grant execute on function public.purge_content_outcomes(text)
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 131, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
