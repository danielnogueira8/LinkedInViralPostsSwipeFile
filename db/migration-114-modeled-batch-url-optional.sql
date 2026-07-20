-- Migration 114: allow url-less sources in modeled draft batches.
--
-- A source URL is only used for the "Open on LinkedIn" chip on finished drafts;
-- the post itself is fully modelable from id + text. Requiring a URL made the
-- durable batch strictly more demanding than the single-draft path, so scraped
-- posts with a null url column were silently dropped. This migration relaxes
-- the database layer to match the TypeScript contract.

begin;

-- 1. Make source_url nullable on slots and relax its check constraint.
alter table public.modeled_draft_slots
  alter column source_url drop not null;

alter table public.modeled_draft_slots
  drop constraint if exists modeled_draft_slots_source_url_check;

alter table public.modeled_draft_slots
  add constraint modeled_draft_slots_source_url_check
  check (
    source_url is null
    or (
      char_length(source_url) between 1 and 2048
      and source_url = btrim(source_url)
      and source_url ~ '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'
    )
  );

-- 2. Recreate claim_modeled_draft_batch with url-optional source validation.
create or replace function public.claim_modeled_draft_batch(
  p_workspace_id text,
  p_operation_key text,
  p_request_hash text,
  p_expected_count integer,
  p_sources jsonb,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_batch public.modeled_draft_batches%rowtype;
  v_source jsonb;
  v_canonical_sources jsonb := '[]'::jsonb;
  v_source_id text;
  v_source_url text;
  v_source_title text;
  v_source_published_at text;
  v_source_text text;
  v_source_hash text;
  v_computed_hash text;
  v_seen_source_ids text[] := array[]::text[];
  v_index integer := 0;
  v_token uuid;
  v_expires_at timestamptz;
  v_claim_status text;
begin
  if p_workspace_id is null
    or p_workspace_id <> btrim(p_workspace_id)
    or char_length(p_workspace_id) not between 1 and 255
    or p_operation_key is null
    or p_operation_key <> btrim(p_operation_key)
    or char_length(p_operation_key) not between 1 and 200
    or p_request_hash is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_expected_count is null
    or p_expected_count not between 2 and 6
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and 600
  then
    raise exception 'invalid modeled draft batch claim'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'modeled_draft_batch:' || p_workspace_id || ':' || p_operation_key,
      0
    )
  );

  select batch.*
  into v_batch
  from public.modeled_draft_batches as batch
  where batch.workspace_id = p_workspace_id
    and batch.operation_key = p_operation_key
  for update;

  if found then
    if v_batch.request_hash <> p_request_hash
      or v_batch.expected_count <> p_expected_count
    then
      raise exception 'modeled draft batch request conflict'
        using errcode = '22023';
    end if;

    if v_batch.status = 'completed' then
      v_claim_status := 'completed';
    elsif v_batch.status = 'active'
      and v_batch.lease_expires_at > clock_timestamp()
    then
      v_claim_status := 'busy';
    else
      v_token := gen_random_uuid();
      v_expires_at := clock_timestamp() + make_interval(secs => p_lease_seconds);
      update public.modeled_draft_batches as batch
      set status = 'active',
          lease_token = v_token,
          lease_expires_at = v_expires_at,
          pause_reason = null,
          updated_at = clock_timestamp()
      where batch.id = v_batch.id
      returning batch.* into v_batch;
      v_claim_status := 'resumed';
    end if;

    return jsonb_build_object(
      'status', v_claim_status,
      'batch_id', v_batch.id,
      'request_hash', v_batch.request_hash,
      'lease_token', case
        when v_claim_status = 'resumed' then v_token
        else null
      end,
      'lease_expires_at', case
        when v_claim_status = 'resumed' then v_expires_at
        when v_claim_status = 'busy' then v_batch.lease_expires_at
        else null
      end,
      'expected_count', v_batch.expected_count,
      'sources', v_batch.sources,
      'slots', public.modeled_draft_batch_slots_snapshot(v_batch.id)
    );
  end if;

  if p_sources is null
    or jsonb_typeof(p_sources) is distinct from 'array'
    or jsonb_array_length(p_sources) < p_expected_count
    or jsonb_array_length(p_sources) > p_expected_count + 5
  then
    raise exception 'invalid modeled draft source pool'
      using errcode = '22023';
  end if;

  for v_source in
    select value from jsonb_array_elements(p_sources)
  loop
    if jsonb_typeof(v_source) <> 'object' then
      raise exception 'invalid modeled draft source'
        using errcode = '22023';
    end if;
    v_source_id := v_source ->> 'id';
    v_source_url := v_source ->> 'url';
    v_source_title := v_source ->> 'title';
    v_source_published_at := v_source ->> 'published_at';
    v_source_text := v_source ->> 'text';
    v_source_hash := v_source ->> 'hash';
    if jsonb_typeof(v_source -> 'id') is distinct from 'string'
      or jsonb_typeof(v_source -> 'text') is distinct from 'string'
      or jsonb_typeof(v_source -> 'hash') is distinct from 'string'
      or (
        v_source -> 'url' is not null
        and jsonb_typeof(v_source -> 'url') is distinct from 'string'
      )
      or coalesce(jsonb_typeof(v_source -> 'title'), 'null')
        not in ('string', 'null')
      or coalesce(jsonb_typeof(v_source -> 'published_at'), 'null')
        not in ('string', 'null')
      or v_source_id is null
      or v_source_id <> btrim(v_source_id)
      or char_length(v_source_id) not between 1 and 200
      or v_source_text is null
      or char_length(v_source_text) not between 1 and 20000
      or v_source_hash is null
      or v_source_hash !~ '^[0-9a-f]{64}$'
      or (
        v_source_title is not null
        and (
          v_source_title <> btrim(v_source_title)
          or char_length(v_source_title) not between 1 and 1000
        )
      )
      or (
        v_source_published_at is not null
        and (
          v_source_published_at <> btrim(v_source_published_at)
          or char_length(v_source_published_at) not between 1 and 100
        )
      )
      or (
        v_source_url is not null
        and (
          v_source_url <> btrim(v_source_url)
          or char_length(v_source_url) not between 1 and 2048
          or v_source_url !~ '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'
        )
      )
      or v_source_id = any(v_seen_source_ids)
    then
      raise exception 'invalid modeled draft source'
        using errcode = '22023';
    end if;
    v_computed_hash := encode(public.digest(v_source_text, 'sha256'), 'hex');
    if v_source_hash <> v_computed_hash then
      raise exception 'modeled draft source hash mismatch'
        using errcode = '22023';
    end if;
    v_seen_source_ids := array_append(v_seen_source_ids, v_source_id);
    v_canonical_sources := v_canonical_sources || jsonb_build_array(
      jsonb_build_object(
        'id', v_source_id,
        'url', v_source_url,
        'title', v_source_title,
        'published_at', v_source_published_at,
        'text', v_source_text,
        'hash', v_source_hash
      )
    );
  end loop;

  v_token := gen_random_uuid();
  v_expires_at := clock_timestamp() + make_interval(secs => p_lease_seconds);
  insert into public.modeled_draft_batches (
    workspace_id,
    operation_key,
    request_hash,
    expected_count,
    sources,
    status,
    lease_token,
    lease_expires_at
  ) values (
    p_workspace_id,
    p_operation_key,
    p_request_hash,
    p_expected_count,
    v_canonical_sources,
    'active',
    v_token,
    v_expires_at
  )
  returning * into v_batch;

  for v_index in 0..p_expected_count - 1 loop
    v_source := v_canonical_sources -> v_index;
    insert into public.modeled_draft_slots (
      batch_id,
      workspace_id,
      slot_index,
      source_id,
      source_url,
      source_text,
      source_hash,
      source_history
    ) values (
      v_batch.id,
      p_workspace_id,
      v_index,
      v_source ->> 'id',
      v_source ->> 'url',
      v_source ->> 'text',
      v_source ->> 'hash',
      jsonb_build_array(v_source ->> 'id')
    );
  end loop;

  return jsonb_build_object(
    'status', 'created',
    'batch_id', v_batch.id,
    'request_hash', v_batch.request_hash,
    'lease_token', v_token,
    'lease_expires_at', v_expires_at,
    'expected_count', v_batch.expected_count,
    'sources', v_batch.sources,
    'slots', public.modeled_draft_batch_slots_snapshot(v_batch.id)
  );
end;
$$;

-- 3. Recreate checkpoint_modeled_draft_slot with url-optional provenance checks.
create or replace function public.checkpoint_modeled_draft_slot(
  p_workspace_id text,
  p_batch_id uuid,
  p_lease_token uuid,
  p_slot_index integer,
  p_expected_state text,
  p_next_state text,
  p_source_id text,
  p_body text default null,
  p_provenance jsonb default null,
  p_rejection_code text default null,
  p_attempt_increment integer default 1,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_batch public.modeled_draft_batches%rowtype;
  v_slot public.modeled_draft_slots%rowtype;
  v_source jsonb;
  v_source_url text;
  v_body_hash text;
  v_lease_expires_at timestamptz;
  v_slots jsonb;
begin
  if p_workspace_id is null
    or p_workspace_id <> btrim(p_workspace_id)
    or char_length(p_workspace_id) not between 1 and 255
    or p_batch_id is null
    or p_lease_token is null
    or p_slot_index is null
    or p_slot_index not between 0 and 5
    or p_expected_state not in ('assigned', 'accepted')
    or p_next_state not in ('assigned', 'accepted')
    or p_source_id is null
    or p_source_id <> btrim(p_source_id)
    or char_length(p_source_id) not between 1 and 200
    or p_attempt_increment is null
    or p_attempt_increment not between 0 and 100
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and 600
    or (
      p_rejection_code is not null
      and char_length(p_rejection_code) not between 1 and 100
    )
  then
    raise exception 'invalid modeled draft slot checkpoint'
      using errcode = '22023';
  end if;

  select batch.*
  into v_batch
  from public.modeled_draft_batches as batch
  where batch.id = p_batch_id
    and batch.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'modeled draft batch not found'
      using errcode = '22023';
  end if;
  if v_batch.status <> 'active'
    or v_batch.lease_token is distinct from p_lease_token
    or v_batch.lease_expires_at <= clock_timestamp()
  then
    raise exception 'modeled draft batch lease is not active'
      using errcode = '55000';
  end if;

  select slot.*
  into v_slot
  from public.modeled_draft_slots as slot
  where slot.batch_id = p_batch_id
    and slot.workspace_id = p_workspace_id
    and slot.slot_index = p_slot_index
  for update;
  if not found then
    raise exception 'modeled draft slot not found'
      using errcode = '22023';
  end if;
  if v_slot.state <> p_expected_state then
    raise exception 'modeled draft slot compare-and-set failed'
      using errcode = '40001';
  end if;
  if v_slot.state = 'accepted' then
    raise exception 'accepted modeled draft slot is immutable'
      using errcode = '55000';
  end if;

  select item.value
  into v_source
  from jsonb_array_elements(v_batch.sources) as item(value)
  where item.value ->> 'id' = p_source_id
  limit 1;
  if v_source is null then
    raise exception 'replacement source is not in the frozen pool'
      using errcode = '22023';
  end if;
  v_source_url := v_source ->> 'url';

  if p_next_state = 'assigned' then
    if p_next_state = p_expected_state and p_source_id = v_slot.source_id then
      raise exception 'source replacement must choose a new source'
        using errcode = '22023';
    end if;
    if p_body is not null or p_provenance is not null then
      raise exception 'assigned checkpoint cannot contain a body or provenance'
        using errcode = '22023';
    end if;
    if v_slot.replacement_count >= 1 then
      raise exception 'modeled draft slot replacement limit reached'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.modeled_draft_slots as other_slot
      cross join lateral jsonb_array_elements_text(other_slot.source_history) as history(source_id)
      where other_slot.batch_id = p_batch_id
        and history.source_id = p_source_id
    ) then
      raise exception 'replacement source was already used in this batch'
        using errcode = '23505';
    end if;
  elsif p_source_id <> v_slot.source_id then
    raise exception 'checkpoint source does not match the assigned source'
      using errcode = '22023';
  end if;

  if p_next_state = 'accepted' then
    if p_body is null
      or char_length(p_body) not between 1 and 3500
    then
      raise exception 'accepted body is invalid'
        using errcode = '22023';
    end if;
    v_body_hash := encode(public.digest(p_body, 'sha256'), 'hex');
  end if;

  if p_next_state = 'accepted' then
    if p_expected_state <> 'assigned'
      or p_provenance is null
      or jsonb_typeof(p_provenance) is distinct from 'object'
      or (p_provenance ->> 'kind') is distinct from 'modeled'
      or (p_provenance ->> 'source_id') is distinct from p_source_id
      or (p_provenance ->> 'source_hash') is distinct from (v_source ->> 'hash')
      or (p_provenance ->> 'source_url') is distinct from v_source_url
      or jsonb_typeof(p_provenance -> 'artifact') is distinct from 'object'
      or coalesce(p_provenance #>> '{artifact,id}', '') = ''
      or char_length(p_provenance #>> '{artifact,id}') > 255
      or coalesce(p_provenance #>> '{artifact,title}', '') = ''
      or char_length(p_provenance #>> '{artifact,title}') > 255
      or jsonb_typeof(p_provenance #> '{artifact,meta}') is distinct from 'object'
      or (p_provenance #>> '{artifact,meta,modeled_draft_slot_id}')
        is distinct from p_batch_id::text || ':slot-' || p_slot_index::text
      or (p_provenance #>> '{artifact,meta,modeled_draft_slot_index}')
        is distinct from p_slot_index::text
      or (p_provenance #>> '{artifact,meta,source}')
        is distinct from 'model_source'
      or (p_provenance #>> '{artifact,meta,source_post_id}')
        is distinct from p_source_id
      or (p_provenance #>> '{artifact,meta,source_url}')
        is distinct from v_source_url
      or p_rejection_code is not null
    then
      raise exception 'accepted provenance does not match the assigned source'
        using errcode = '22023';
    end if;
  end if;

  if p_next_state = 'assigned' then
    update public.modeled_draft_slots as slot
    set state = 'assigned',
        source_id = v_source ->> 'id',
        source_url = v_source_url,
        source_text = v_source ->> 'text',
        source_hash = v_source ->> 'hash',
        source_history = slot.source_history || jsonb_build_array(p_source_id),
        replacement_count = slot.replacement_count + 1,
        accepted_body = null,
        accepted_body_hash = null,
        accepted_provenance = null,
        accepted_at = null,
        attempt_count = slot.attempt_count + p_attempt_increment,
        rejection_code = p_rejection_code,
        updated_at = clock_timestamp()
    where slot.batch_id = p_batch_id
      and slot.slot_index = p_slot_index
      and slot.state = p_expected_state;
  else
    update public.modeled_draft_slots as slot
    set state = 'accepted',
        accepted_body = p_body,
        accepted_body_hash = v_body_hash,
        accepted_provenance = p_provenance,
        accepted_at = clock_timestamp(),
        attempt_count = slot.attempt_count + p_attempt_increment,
        rejection_code = null,
        updated_at = clock_timestamp()
    where slot.batch_id = p_batch_id
      and slot.slot_index = p_slot_index
      and slot.state = p_expected_state;
  end if;

  if not found then
    raise exception 'modeled draft slot compare-and-set failed'
      using errcode = '40001';
  end if;

  v_lease_expires_at := clock_timestamp() + make_interval(secs => p_lease_seconds);
  update public.modeled_draft_batches as batch
  set lease_expires_at = v_lease_expires_at,
      updated_at = clock_timestamp()
  where batch.id = p_batch_id
    and batch.workspace_id = p_workspace_id
    and batch.status = 'active'
    and batch.lease_token = p_lease_token;

  v_slots := public.modeled_draft_batch_slots_snapshot(p_batch_id);
  return (v_slots -> p_slot_index) || jsonb_build_object(
    'lease_expires_at', v_lease_expires_at
  );
end;
$$;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 114, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
