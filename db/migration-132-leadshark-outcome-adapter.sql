-- Migration 132: atomic LeadShark stats-to-Content-Outcome adapter.
--
-- The checkpoint is separate from the display snapshot so a missing/invalid
-- metric cannot erase the durable high-water mark. Counter resets increment an
-- epoch, giving post-reset counts a fresh idempotency namespace.

begin;

alter table public.leadshark_automations
  add column if not exists initial_dms_checkpoint bigint not null default 0
    check (initial_dms_checkpoint >= 0),
  add column if not exists stats_epoch integer not null default 0
    check (stats_epoch >= 0);

-- Counts synced before Content Outcomes existed are a baseline, not evidence
-- that occurred at deployment time. Preserve them as the initial high-water
-- and import only subsequent verified deltas.
update public.leadshark_automations
set initial_dms_checkpoint = case
  when coalesce(stats->>'total_dms_sent', stats->>'dms_sent', '')
    ~ '^[0-9]+$'
    and coalesce(stats->>'total_dms_sent', stats->>'dms_sent')::numeric
      <= 2147483647
  then coalesce(
    stats->>'total_dms_sent',
    stats->>'dms_sent'
  )::bigint
  else 0
end
where initial_dms_checkpoint = 0
  and stats_epoch = 0
  and stats_synced_at is not null;

create unique index if not exists leadshark_automations_remote_identity_idx
  on public.leadshark_automations (
    workspace_id,
    leadshark_automation_id
  )
  where leadshark_automation_id is not null and status <> 'deleted';

create or replace function public.ingest_leadshark_stats_outcome(
  p_workspace_id text,
  p_automation_id uuid,
  p_leadshark_automation_id text,
  p_stats jsonb,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  automation public.leadshark_automations;
  metric_text text;
  current_count bigint;
  delta_count bigint;
  next_epoch integer;
  outcome_id uuid;
  outcome_key text;
  lineage_id uuid;
  existing_outcome public.content_outcomes;
begin
  if nullif(btrim(p_workspace_id), '') is null
    or nullif(btrim(p_leadshark_automation_id), '') is null
    or length(p_leadshark_automation_id) > 130
    or p_observed_at is null
    or p_stats is null
    or jsonb_typeof(p_stats) <> 'object'
  then
    raise exception 'Valid LeadShark stats scope is required'
      using errcode = '22023';
  end if;

  select * into automation
  from public.leadshark_automations candidate
  where candidate.id = p_automation_id
    and candidate.workspace_id = p_workspace_id
    and candidate.status = 'active'
    and candidate.leadshark_automation_id = p_leadshark_automation_id
  for update;
  if not found then
    raise exception 'Active LeadShark automation not found'
      using errcode = 'P0002';
  end if;

  if automation.stats_synced_at is not null
    and p_observed_at <= automation.stats_synced_at
  then
    return jsonb_build_object(
      'status', 'stale_snapshot',
      'checkpoint', automation.initial_dms_checkpoint,
      'epoch', automation.stats_epoch
    );
  end if;

  metric_text := coalesce(
    p_stats->>'total_dms_sent',
    p_stats->>'dms_sent'
  );
  if metric_text is null or metric_text !~ '^[0-9]+$' then
    update public.leadshark_automations
    set stats = p_stats,
        stats_synced_at = p_observed_at,
        updated_at = now()
    where id = automation.id and workspace_id = p_workspace_id;
    return jsonb_build_object('status', 'no_metric');
  end if;

  if metric_text::numeric > 2147483647 then
    raise exception 'LeadShark initial DM count is outside the supported range'
      using errcode = '22003';
  end if;
  current_count := metric_text::bigint;
  next_epoch := automation.stats_epoch;

  if current_count < automation.initial_dms_checkpoint then
    next_epoch := automation.stats_epoch + 1;
    delta_count := current_count;
  else
    delta_count := current_count - automation.initial_dms_checkpoint;
  end if;

  if delta_count > 0 then
    select lineage.id into lineage_id
    from public.artifact_lineage lineage
    where lineage.workspace_id = p_workspace_id
      and lineage.artifact_id = automation.artifact_id;

    outcome_key := concat(
      'leadshark:', p_leadshark_automation_id,
      ':initial-dm:', next_epoch, ':', current_count
    );
    if length(outcome_key) > 160 then
      raise exception 'LeadShark outcome identity is too long'
        using errcode = '22001';
    end if;

    insert into public.content_outcomes (
      schema_version, workspace_id, draft_id, lineage_id, kind, source,
      external_id, idempotency_key, status, supersedes_outcome_id,
      confidence, quantity, amount_minor, currency, occurred_at
    ) values (
      1, p_workspace_id, automation.artifact_id, lineage_id,
      'lead_magnet_conversion', 'leadshark',
      p_leadshark_automation_id || ':initial-dm', outcome_key,
      'active', null, 0.8, delta_count::integer, null, null, p_observed_at
    )
    on conflict (workspace_id, idempotency_key) do nothing
    returning id into outcome_id;

    if outcome_id is null then
      select * into existing_outcome
      from public.content_outcomes existing
      where existing.workspace_id = p_workspace_id
        and existing.idempotency_key = outcome_key;
      if not found
        or existing_outcome.draft_id is distinct from automation.artifact_id
        or existing_outcome.kind is distinct from 'lead_magnet_conversion'
        or existing_outcome.source is distinct from 'leadshark'
        or existing_outcome.external_id is distinct from
          p_leadshark_automation_id || ':initial-dm'
        or existing_outcome.status is distinct from 'active'
        or existing_outcome.confidence is distinct from 0.8
        or existing_outcome.quantity is distinct from delta_count::integer
      then
        raise exception 'LeadShark outcome idempotency collision'
          using errcode = '23505';
      end if;
      outcome_id := existing_outcome.id;
    end if;
  end if;

  update public.leadshark_automations
  set stats = p_stats,
      stats_synced_at = p_observed_at,
      initial_dms_checkpoint = current_count,
      stats_epoch = next_epoch,
      updated_at = now()
  where id = automation.id and workspace_id = p_workspace_id;

  return jsonb_build_object(
    'status', case when delta_count > 0 then 'ingested' else 'no_delta' end,
    'outcome_id', outcome_id,
    'delta', delta_count,
    'checkpoint', current_count,
    'epoch', next_epoch
  );
end;
$$;

revoke all on function public.ingest_leadshark_stats_outcome(
  text, uuid, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.ingest_leadshark_stats_outcome(
  text, uuid, text, jsonb, timestamptz
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 132, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
