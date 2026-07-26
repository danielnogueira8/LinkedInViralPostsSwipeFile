-- Migration 128: reviewable evidence for preferences learned from revisions.
--
-- A distilled rule must remain traceable to the exact manual edits that
-- supported it. Links are append-only, Workspace-scoped, and written only by
-- the server-side distiller. The Voice UI can then explain why a rule exists
-- without copying draft bodies into another durable store.

begin;

create table if not exists public.content_preference_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  preference_id uuid not null
    references public.content_preferences(id) on delete cascade,
  revision_event_id uuid not null
    references public.draft_edit_events(id) on delete cascade,
  batch_id uuid not null,
  rule_snapshot text not null
    check (length(btrim(rule_snapshot)) between 1 and 160),
  created_at timestamptz not null default now(),
  unique (preference_id, revision_event_id)
);

create index if not exists content_preference_evidence_workspace_idx
  on public.content_preference_evidence
    (workspace_id, preference_id, created_at desc);

-- This receipt is deliberately separate from the preference and its evidence.
-- If a user deletes a learned rule, the nullable FK is cleared but the batch
-- receipt remains, so a worker retry cannot resurrect a dismissed rule.
create table if not exists public.content_preference_learning_outcomes (
  workspace_id text not null,
  batch_id uuid not null,
  candidate_index integer not null check (candidate_index between 0 and 2),
  preference_id uuid
    references public.content_preferences(id) on delete set null,
  outcome_kind text not null
    check (
      outcome_kind in (
        'created',
        'linked_existing',
        'ignored_duplicate',
        'ignored_at_cap'
      )
    ),
  rule_snapshot text not null
    check (length(btrim(rule_snapshot)) between 1 and 160),
  created_at timestamptz not null default now(),
  primary key (workspace_id, batch_id, candidate_index)
);

alter table public.content_preference_learning_outcomes enable row level security;

-- All preference writers (API, chat memory, and the edit distiller) pass
-- through this trigger-backed key registry. It closes the race that an
-- application-level duplicate read cannot: two concurrent transactions may
-- both read "missing", but only one canonical Workspace/key claim can commit.
create table if not exists public.content_preference_dedup_claims (
  workspace_id text not null,
  dedup_key text not null,
  preference_id uuid not null unique
    references public.content_preferences(id)
    on delete cascade
    deferrable initially deferred,
  created_at timestamptz not null default now(),
  primary key (workspace_id, dedup_key),
  check (length(dedup_key) = 64)
);

alter table public.content_preference_dedup_claims enable row level security;

create or replace function public.content_preference_dedup_key(p_rule text)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  with normalized as (
    select translate(
      lower(
        left(
          btrim(
            regexp_replace(
              translate(
                p_rule,
                U&'\0001\0002\0003\0004\0005\0006\0007\0008\0009\000A\000B\000C\000D\000E\000F\0010\0011\0012\0013\0014\0015\0016\0017\0018\0019\001A\001B\001C\001D\001E\001F\0020\007F\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF',
                repeat(' ', 52)
              ),
              ' +',
              ' ',
              'g'
            )
          ),
          160
        ) collate "und-x-icu"
      ),
      U&'\2019\2018\201C\201D\2013\2014\2026',
      U&'\0027\0027\0022\0022\002D\002D\002E'
    ) as value
  ),
  ascii_folded as (
    select
      value,
      btrim(regexp_replace(value, '[^a-z0-9]+', ' ', 'g')) as value_ascii,
      btrim(
        regexp_replace(
          translate(
            value,
            U&'\0021\0022\0023\0024\0025\0026\0027\0028\0029\002A\002B\002C\002D\002E\002F\003A\003B\003C\003D\003E\003F\0040\005B\005C\005D\005E\005F\0060\007B\007C\007D\007E' ||
              U&'\3002\FF01\FF1F\3001\FF0C\FF1B\FF1A\FF08\FF09\3010\3011\300A\300B\FF0E\061F',
            repeat(' ', 47)
          ),
          ' +',
          ' ',
          'g'
        )
      ) as value_unicode
    from normalized
  )
  select encode(
    digest(
      case
        when octet_length(value) > length(value)
          then 'u:' || coalesce(nullif(value_unicode, ''), value)
        else value_ascii
      end,
      'sha256'
    ),
    'hex'
  )
  from ascii_folded
$$;

-- Hold ordinary preference writers out of the backfill-to-trigger window.
-- Without this transaction-scoped lock, a row could commit after the snapshot
-- below but before the trigger exists and never receive a registry claim.
lock table public.content_preferences in share row exclusive mode;

insert into public.content_preference_dedup_claims (
  workspace_id,
  dedup_key,
  preference_id
)
select distinct on (ranked.workspace_id, ranked.dedup_key)
  ranked.workspace_id,
  ranked.dedup_key,
  ranked.id
from (
  select
    preference.id,
    preference.workspace_id,
    public.content_preference_dedup_key(preference.rule) as dedup_key,
    preference.source,
    preference.created_at
  from public.content_preferences preference
) ranked
where length(ranked.dedup_key) > 0
order by
  ranked.workspace_id,
  ranked.dedup_key,
  case when ranked.source = 'user' then 0 else 1 end,
  ranked.created_at,
  ranked.id
on conflict do nothing;

create or replace function public.claim_content_preference_dedup_key()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_key text;
begin
  next_key := public.content_preference_dedup_key(new.rule);

  if tg_op = 'UPDATE' then
    if old.workspace_id = new.workspace_id
      and public.content_preference_dedup_key(old.rule) = next_key
    then
      return new;
    end if;
    delete from public.content_preference_dedup_claims claim
    where claim.preference_id = old.id;
  end if;

  insert into public.content_preference_dedup_claims (
    workspace_id,
    dedup_key,
    preference_id
  ) values (new.workspace_id, next_key, new.id);
  return new;
end;
$$;

drop trigger if exists content_preferences_claim_dedup_key
  on public.content_preferences;
create trigger content_preferences_claim_dedup_key
  before insert or update of workspace_id, rule
  on public.content_preferences
  for each row execute function public.claim_content_preference_dedup_key();

create or replace function public.reassign_content_preference_dedup_key()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.content_preference_dedup_claims claim
    where claim.preference_id = old.id;
  end if;

  insert into public.content_preference_dedup_claims (
    workspace_id,
    dedup_key,
    preference_id
  )
  select
    remaining.workspace_id,
    public.content_preference_dedup_key(remaining.rule),
    remaining.id
  from public.content_preferences remaining
  where remaining.workspace_id = old.workspace_id
    and public.content_preference_dedup_key(remaining.rule) =
      public.content_preference_dedup_key(old.rule)
  order by
    case when remaining.source = 'user' then 0 else 1 end,
    remaining.created_at,
    remaining.id
  limit 1
  on conflict do nothing;
  return old;
end;
$$;

drop trigger if exists content_preferences_reassign_dedup_key
  on public.content_preferences;
create trigger content_preferences_reassign_dedup_key
  after delete on public.content_preferences
  for each row execute function public.reassign_content_preference_dedup_key();

drop trigger if exists content_preferences_reassign_old_dedup_key
  on public.content_preferences;
create trigger content_preferences_reassign_old_dedup_key
  after update of workspace_id, rule on public.content_preferences
  for each row
  when (
    old.workspace_id is distinct from new.workspace_id
    or old.rule is distinct from new.rule
  )
  execute function public.reassign_content_preference_dedup_key();

-- Migration 127 could persist a string-only result before evidence attribution
-- existed. Upgrade unfinished v2 batches in place so rolling-deploy retries
-- keep their original rules and use that batch's bounded edit set as evidence.
with legacy_batches as (
  select
    processing_state.workspace_id,
    processing_state.processor,
    processing_state.batch_id,
    processing_state.distillation_result,
    array_agg(
      processing_state.event_id order by processing_state.event_id
    ) as event_ids
  from public.content_learning_processing_cursors processing_state
  where processing_state.processor = 'voice_edit_distiller_v2'
    and processing_state.batch_id is not null
    and processing_state.completed_at is null
    and jsonb_typeof(processing_state.distillation_result->'rules') = 'array'
    and not exists (
      select 1
      from jsonb_array_elements(
        processing_state.distillation_result->'rules'
      ) candidate(value)
      where jsonb_typeof(candidate.value) <> 'string'
    )
  group by
    processing_state.workspace_id,
    processing_state.processor,
    processing_state.batch_id,
    processing_state.distillation_result
),
upgraded_batches as (
  select
    legacy.workspace_id,
    legacy.processor,
    legacy.batch_id,
    jsonb_build_object(
      'rules',
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'rule', candidate.value #>> '{}',
              'evidenceEventIds', to_jsonb(legacy.event_ids)
            )
            order by candidate.ordinality
          )
          from jsonb_array_elements(
            legacy.distillation_result->'rules'
          ) with ordinality candidate(value, ordinality)
        ),
        '[]'::jsonb
      )
    ) as upgraded_result
  from legacy_batches legacy
)
update public.content_learning_processing_cursors processing_state
set
  distillation_result = upgraded.upgraded_result,
  updated_at = now()
from upgraded_batches upgraded
where processing_state.workspace_id = upgraded.workspace_id
  and processing_state.processor = upgraded.processor
  and processing_state.batch_id = upgraded.batch_id;

create or replace function public.validate_content_preference_evidence_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.content_preferences preference
    where preference.id = new.preference_id
      and preference.workspace_id = new.workspace_id
      and preference.source = 'edit_delta'
  ) then
    raise exception 'Preference evidence requires a learned edit rule in the Workspace'
      using errcode = '23503';
  end if;

  if not exists (
    select 1
    from public.draft_edit_events event
    where event.id = new.revision_event_id
      and event.workspace_id = new.workspace_id
  ) then
    raise exception 'Preference evidence revision is outside the Workspace'
      using errcode = '23503';
  end if;

  return new;
end;
$$;

drop trigger if exists content_preference_evidence_validate_scope
  on public.content_preference_evidence;
create trigger content_preference_evidence_validate_scope
  before insert or update of workspace_id, preference_id, revision_event_id
  on public.content_preference_evidence
  for each row execute function public.validate_content_preference_evidence_scope();

create or replace function public.reject_content_preference_evidence_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Preference evidence is append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists content_preference_evidence_reject_update
  on public.content_preference_evidence;
create trigger content_preference_evidence_reject_update
  before update on public.content_preference_evidence
  for each row execute function public.reject_content_preference_evidence_update();

alter table public.content_preference_evidence enable row level security;

drop policy if exists content_preference_evidence_select
  on public.content_preference_evidence;
create policy content_preference_evidence_select
  on public.content_preference_evidence
  for select
  using (workspace_id = auth_workspace_id());

create or replace function public.persist_content_preference_candidate(
  p_workspace_id text,
  p_batch_id uuid,
  p_candidate_index integer,
  p_rule_snapshot text,
  p_revision_event_ids uuid[],
  p_matching_preference_id uuid default null
)
returns table (
  preference_id uuid,
  outcome_kind text,
  inserted_preference boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_candidate jsonb;
  target_preference_id uuid;
  target_preference_source text;
  resolved_outcome text;
begin
  if p_workspace_id is null or length(btrim(p_workspace_id)) = 0 then
    raise exception 'Workspace is required' using errcode = '22023';
  end if;
  if p_batch_id is null or p_candidate_index not between 0 and 2 then
    raise exception 'Batch candidate is invalid' using errcode = '22023';
  end if;
  if p_rule_snapshot is null
    or length(btrim(p_rule_snapshot)) not between 1 and 160
  then
    raise exception 'Rule snapshot is invalid' using errcode = '22023';
  end if;
  if p_revision_event_ids is null
    or cardinality(p_revision_event_ids) not between 1 and 100
  then
    raise exception 'Revision evidence is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'content_preference_candidate:' || p_workspace_id,
      0
    )
  );

  -- A durable outcome always wins over mutable current rule text. This is what
  -- makes retries idempotent after a user edits or deletes the learned rule.
  return query
  select
    existing.preference_id,
    existing.outcome_kind,
    false
  from public.content_preference_learning_outcomes existing
  where existing.workspace_id = p_workspace_id
    and existing.batch_id = p_batch_id
    and existing.candidate_index = p_candidate_index;
  if found then
    return;
  end if;

  select processing_state.distillation_result->'rules'->p_candidate_index
  into saved_candidate
  from public.content_learning_processing_cursors processing_state
  where processing_state.workspace_id = p_workspace_id
    and processing_state.processor = 'voice_edit_distiller_v2'
    and processing_state.batch_id = p_batch_id
    and processing_state.distillation_result is not null
  limit 1;

  if saved_candidate is null
    or saved_candidate->>'rule' <> p_rule_snapshot
    or not (
      select
        coalesce(
          array_agg(value::uuid order by value::uuid),
          array[]::uuid[]
        ) = (
          select array_agg(distinct requested order by requested)
          from unnest(p_revision_event_ids) requested
        )
      from jsonb_array_elements_text(
        saved_candidate->'evidenceEventIds'
      ) evidence(value)
    )
  then
    raise exception 'Candidate evidence does not match the persisted batch result'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(p_revision_event_ids) requested(event_id)
    where not exists (
      select 1
      from public.content_learning_processing_cursors processing_state
      where processing_state.workspace_id = p_workspace_id
        and processing_state.processor = 'voice_edit_distiller_v2'
        and processing_state.batch_id = p_batch_id
        and processing_state.event_id = requested.event_id
    )
  ) then
    raise exception 'Revision evidence is outside the persisted batch'
      using errcode = '23503';
  end if;

  if p_matching_preference_id is not null then
    select current_preference.id, current_preference.source
    into target_preference_id, target_preference_source
    from public.content_preferences current_preference
    where current_preference.id = p_matching_preference_id
      and current_preference.workspace_id = p_workspace_id
    for key share;
    if target_preference_id is null then
      resolved_outcome := 'ignored_duplicate';
      target_preference_source := 'deleted';
    else
      resolved_outcome := case
        when target_preference_source = 'edit_delta' then 'linked_existing'
        else 'ignored_duplicate'
      end;
    end if;
  else
    select current_preference.id, current_preference.source
    into target_preference_id, target_preference_source
    from public.content_preferences current_preference
    where current_preference.workspace_id = p_workspace_id
      and public.content_preference_dedup_key(current_preference.rule) =
        public.content_preference_dedup_key(p_rule_snapshot)
    order by current_preference.created_at, current_preference.id
    limit 1
    for key share;
    if target_preference_id is not null then
      resolved_outcome := case
        when target_preference_source = 'edit_delta' then 'linked_existing'
        else 'ignored_duplicate'
      end;
    else
      if (
        select count(*)
        from public.content_preferences current_preference
        where current_preference.workspace_id = p_workspace_id
      ) >= 20 then
        target_preference_id := null;
        target_preference_source := 'at_cap';
        resolved_outcome := 'ignored_at_cap';
      else
        begin
          insert into public.content_preferences (workspace_id, rule, source)
          values (p_workspace_id, p_rule_snapshot, 'edit_delta')
          returning id into target_preference_id;
          target_preference_source := 'edit_delta';
          resolved_outcome := 'created';
        exception
          when unique_violation then
            select current_preference.id, current_preference.source
            into target_preference_id, target_preference_source
            from public.content_preferences current_preference
            where current_preference.workspace_id = p_workspace_id
              and public.content_preference_dedup_key(
                current_preference.rule
              ) = public.content_preference_dedup_key(p_rule_snapshot)
            order by current_preference.created_at, current_preference.id
            limit 1
            for key share;
            if target_preference_id is null then
              raise;
            end if;
            resolved_outcome := case
              when target_preference_source = 'edit_delta'
                then 'linked_existing'
              else 'ignored_duplicate'
            end;
        end;
      end if;
    end if;
  end if;

  insert into public.content_preference_learning_outcomes (
    workspace_id,
    batch_id,
    candidate_index,
    preference_id,
    outcome_kind,
    rule_snapshot
  ) values (
    p_workspace_id,
    p_batch_id,
    p_candidate_index,
    target_preference_id,
    resolved_outcome,
    p_rule_snapshot
  );

  if target_preference_source = 'edit_delta' then
    insert into public.content_preference_evidence (
      workspace_id,
      preference_id,
      revision_event_id,
      batch_id,
      rule_snapshot
    )
    select
      p_workspace_id,
      target_preference_id,
      requested.event_id,
      p_batch_id,
      p_rule_snapshot
    from unnest(p_revision_event_ids) requested(event_id)
    on conflict on constraint
      content_preference_evidence_preference_id_revision_event_id_key
    do nothing;
  end if;

  return query select
    target_preference_id,
    resolved_outcome,
    resolved_outcome = 'created';
end;
$$;

create or replace function public.list_content_preference_evidence(
  p_workspace_id text,
  p_preference_ids uuid[],
  p_per_preference integer default 3
)
returns table (
  id uuid,
  preference_id uuid,
  revision_event_id uuid,
  batch_id uuid,
  rule_snapshot text,
  before_excerpt text,
  after_excerpt text,
  before_truncated boolean,
  after_truncated boolean,
  edit_origin text,
  change_summary jsonb,
  event_created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
begin
  if p_workspace_id is null or length(btrim(p_workspace_id)) = 0
    or p_preference_ids is null
    or cardinality(p_preference_ids) not between 1 and 20
    or p_per_preference is null
    or p_per_preference not between 1 and 5
  then
    raise exception 'Preference evidence request is invalid'
      using errcode = '22023';
  end if;

  return query
  with ranked_evidence as (
    select
      evidence.id,
      evidence.preference_id,
      evidence.revision_event_id,
      evidence.batch_id,
      evidence.rule_snapshot,
      left(event.before_body, 1500) as before_excerpt,
      left(event.after_body, 1500) as after_excerpt,
      length(event.before_body) > 1500 as before_truncated,
      length(event.after_body) > 1500 as after_truncated,
      event.edit_origin,
      event.change_summary,
      event.created_at as event_created_at,
      row_number() over (
        partition by evidence.preference_id
        order by evidence.created_at desc, evidence.id desc
      ) as evidence_rank
    from public.content_preference_evidence evidence
    join public.draft_edit_events event
      on event.id = evidence.revision_event_id
      and event.workspace_id = evidence.workspace_id
    where evidence.workspace_id = p_workspace_id
      and evidence.preference_id = any(p_preference_ids)
  )
  select
    ranked_evidence.id,
    ranked_evidence.preference_id,
    ranked_evidence.revision_event_id,
    ranked_evidence.batch_id,
    ranked_evidence.rule_snapshot,
    ranked_evidence.before_excerpt,
    ranked_evidence.after_excerpt,
    ranked_evidence.before_truncated,
    ranked_evidence.after_truncated,
    ranked_evidence.edit_origin,
    ranked_evidence.change_summary,
    ranked_evidence.event_created_at
  from ranked_evidence
  where ranked_evidence.evidence_rank <= greatest(
    1,
    least(p_per_preference, 5)
  )
  order by ranked_evidence.event_created_at desc, ranked_evidence.id desc;
end;
$$;

revoke all on function public.persist_content_preference_candidate(
  text, uuid, integer, text, uuid[], uuid
) from public, anon, authenticated;
revoke all on function public.list_content_preference_evidence(
  text, uuid[], integer
) from public, anon, authenticated;
grant execute on function public.persist_content_preference_candidate(
  text, uuid, integer, text, uuid[], uuid
) to service_role;
grant execute on function public.list_content_preference_evidence(
  text, uuid[], integer
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 128, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
