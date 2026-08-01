-- Migration 145: atomically move recurring queue bookings and swap occupied
-- occurrences without ever exposing a half-moved queue.

begin;

create or replace function public.move_posting_queue_draft(
  p_workspace_id text,
  p_draft_id uuid,
  p_target_slot_id uuid,
  p_target_occurrence_date date,
  p_target_scheduled_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_snapshot public.chat_artifacts%rowtype;
  source_draft public.chat_artifacts%rowtype;
  target_draft public.chat_artifacts%rowtype;
  target_slot public.posting_slots%rowtype;
  result_drafts jsonb;
begin
  -- Queue moves are uncommon and user initiated. Serializing them per
  -- workspace makes simultaneous drag/drop requests deterministic, while
  -- normal publishing and scheduling remain independent.
  perform pg_advisory_xact_lock(
    hashtextextended('posting-queue-move:' || p_workspace_id, 0)
  );

  select *
  into source_snapshot
  from public.chat_artifacts
  where id = p_draft_id
    and workspace_id = p_workspace_id;

  if not found
    or source_snapshot.schedule_status <> 'scheduled'
    or source_snapshot.posting_slot_id is null
    or source_snapshot.posting_slot_occurrence_date is null
  then
    return jsonb_build_object(
      'ok', false,
      'error', 'This post is no longer available to move in the queue.'
    );
  end if;

  -- Use the same slot -> artifact lock order as the queue assignment trigger
  -- so moves cannot race slot removal or publishing.
  perform 1
  from public.posting_slots
  where id in (source_snapshot.posting_slot_id, p_target_slot_id)
    and workspace_id = p_workspace_id
    and deleted_at is null
  order by id
  for update;

  select *
  into target_slot
  from public.posting_slots
  where id = p_target_slot_id
    and workspace_id = p_workspace_id
    and deleted_at is null;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'The destination posting slot is no longer available.'
    );
  end if;

  if extract(dow from p_target_occurrence_date)::smallint
    <> target_slot.day_of_week
  then
    return jsonb_build_object(
      'ok', false,
      'error', 'The destination slot does not occur on that date.'
    );
  end if;

  perform 1
  from public.chat_artifacts
  where workspace_id = p_workspace_id
    and (
      id = p_draft_id
      or (
        posting_slot_id = p_target_slot_id
        and posting_slot_occurrence_date = p_target_occurrence_date
      )
    )
  order by id
  for update;

  select *
  into source_draft
  from public.chat_artifacts
  where id = p_draft_id
    and workspace_id = p_workspace_id;

  if source_draft.schedule_status <> 'scheduled'
    or source_draft.posting_slot_id is null
    or source_draft.posting_slot_occurrence_date is null
    or source_draft.posting_slot_id <> source_snapshot.posting_slot_id
    or source_draft.posting_slot_occurrence_date
      <> source_snapshot.posting_slot_occurrence_date
  then
    return jsonb_build_object(
      'ok', false,
      'error', 'This post changed while it was being moved. Try again.'
    );
  end if;

  if source_draft.posting_slot_id = p_target_slot_id
    and source_draft.posting_slot_occurrence_date = p_target_occurrence_date
  then
    return jsonb_build_object(
      'ok', true,
      'swapped', false,
      'drafts', jsonb_build_array(
        jsonb_build_object(
          'id', source_draft.id,
          'scheduled_at', source_draft.scheduled_at,
          'schedule_status', source_draft.schedule_status,
          'plan_to_post_on', source_draft.plan_to_post_on,
          'first_comment', source_draft.first_comment,
          'posting_slot_id', source_draft.posting_slot_id,
          'posting_slot_occurrence_date',
            source_draft.posting_slot_occurrence_date
        )
      )
    );
  end if;

  select *
  into target_draft
  from public.chat_artifacts
  where workspace_id = p_workspace_id
    and posting_slot_id = p_target_slot_id
    and posting_slot_occurrence_date = p_target_occurrence_date;

  if found and target_draft.schedule_status <> 'scheduled' then
    return jsonb_build_object(
      'ok', false,
      'error', 'The destination post is locked and cannot be moved.'
    );
  end if;

  -- Release both unique occurrence claims before assigning their new
  -- occurrences. The transaction keeps this intermediate state invisible.
  update public.chat_artifacts
  set
    posting_slot_id = null,
    posting_slot_occurrence_date = null
  where workspace_id = p_workspace_id
    and id in (source_draft.id, target_draft.id);

  update public.chat_artifacts
  set
    scheduled_at = coalesce(
      target_draft.scheduled_at,
      p_target_scheduled_at
    ),
    plan_to_post_on = p_target_occurrence_date,
    posting_slot_id = p_target_slot_id,
    posting_slot_occurrence_date = p_target_occurrence_date,
    lifecycle_version = lifecycle_version + 1
  where id = source_draft.id
    and workspace_id = p_workspace_id;

  if target_draft.id is not null then
    update public.chat_artifacts
    set
      scheduled_at = source_draft.scheduled_at,
      plan_to_post_on = source_draft.posting_slot_occurrence_date,
      posting_slot_id = source_draft.posting_slot_id,
      posting_slot_occurrence_date =
        source_draft.posting_slot_occurrence_date,
      lifecycle_version = lifecycle_version + 1
    where id = target_draft.id
      and workspace_id = p_workspace_id;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'id', artifact.id,
      'scheduled_at', artifact.scheduled_at,
      'schedule_status', artifact.schedule_status,
      'plan_to_post_on', artifact.plan_to_post_on,
      'first_comment', artifact.first_comment,
      'posting_slot_id', artifact.posting_slot_id,
      'posting_slot_occurrence_date',
        artifact.posting_slot_occurrence_date
    )
    order by case when artifact.id = source_draft.id then 0 else 1 end
  )
  into result_drafts
  from public.chat_artifacts artifact
  where artifact.workspace_id = p_workspace_id
    and artifact.id in (source_draft.id, target_draft.id);

  return jsonb_build_object(
    'ok', true,
    'swapped', target_draft.id is not null,
    'drafts', coalesce(result_drafts, '[]'::jsonb)
  );
end
$$;

revoke all on function public.move_posting_queue_draft(
  text,
  uuid,
  uuid,
  date,
  timestamptz
) from public, anon, authenticated;

grant execute on function public.move_posting_queue_draft(
  text,
  uuid,
  uuid,
  date,
  timestamptz
) to service_role;

insert into public.app_schema_version (
  singleton,
  version,
  updated_at
)
values (true, 145, now())
on conflict (singleton) do update
set
  version = excluded.version,
  updated_at = excluded.updated_at;

commit;
