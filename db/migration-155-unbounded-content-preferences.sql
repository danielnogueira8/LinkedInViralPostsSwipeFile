-- Let workspace memory grow without a fixed rule-count ceiling.
--
-- Prompt construction still selects a bounded newest subset in application
-- code. This migration only removes the database write-time ceiling from the
-- atomic edit-learning path.

begin;

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
    hashtextextended('content_preference_candidate:' || p_workspace_id, 0)
  );

  return query
  select existing.preference_id, existing.outcome_kind, false
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

revoke all on function public.persist_content_preference_candidate(
  text, uuid, integer, text, uuid[], uuid
) from public, anon, authenticated;
grant execute on function public.persist_content_preference_candidate(
  text, uuid, integer, text, uuid[], uuid
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 155, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
