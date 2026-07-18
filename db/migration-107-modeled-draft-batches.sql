-- Migration 107: durable, resumable exact-count modeled-draft batches.
--
-- A modeled batch freezes its complete source pool once, checkpoints each
-- stable zero-based slot, and publishes only after every slot is accepted.
-- Expired or explicitly released leases may be resumed without regenerating
-- accepted work. All mutations are fenced through service-only RPCs.

begin;

create extension if not exists pgcrypto;

create table if not exists public.modeled_draft_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null check (
    char_length(workspace_id) between 1 and 255
  ),
  operation_key text not null check (
    char_length(operation_key) between 1 and 200
  ),
  request_hash text not null check (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  expected_count integer not null check (expected_count between 2 and 5),
  sources jsonb not null check (
    jsonb_typeof(sources) = 'array'
    and jsonb_array_length(sources) between expected_count and expected_count + 5
  ),
  status text not null default 'active' check (
    status in ('active', 'paused', 'completed')
  ),
  lease_token uuid,
  lease_expires_at timestamptz,
  pause_reason text check (
    pause_reason is null or pause_reason in (
      'cancelled',
      'deadline',
      'reviewer_unavailable',
      'writer_unavailable',
      'slot_exhausted',
      'source_pool_exhausted',
      'protocol_error',
      'store_unavailable'
    )
  ),
  completed_by_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint modeled_draft_batches_workspace_operation_unique
    unique (workspace_id, operation_key),
  constraint modeled_draft_batches_id_workspace_unique
    unique (id, workspace_id),
  constraint modeled_draft_batches_state_shape check (
    (
      status = 'active'
      and lease_token is not null
      and lease_expires_at is not null
      and pause_reason is null
      and completed_by_token is null
      and completed_at is null
    )
    or
    (
      status = 'paused'
      and lease_token is null
      and lease_expires_at is null
      and pause_reason is not null
      and completed_by_token is null
      and completed_at is null
    )
    or
    (
      status = 'completed'
      and lease_token is null
      and lease_expires_at is null
      and pause_reason is null
      and completed_by_token is not null
      and completed_at is not null
    )
  )
);

create table if not exists public.modeled_draft_slots (
  batch_id uuid not null,
  workspace_id text not null,
  slot_index integer not null check (slot_index between 0 and 4),
  state text not null default 'assigned' check (
    state in ('assigned', 'accepted')
  ),
  source_id text not null check (
    char_length(source_id) between 1 and 200 and source_id = btrim(source_id)
  ),
  source_url text not null check (
    char_length(source_url) between 1 and 2048
    and source_url = btrim(source_url)
    and source_url ~ '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'
  ),
  source_text text not null check (
    char_length(source_text) between 1 and 20000
  ),
  source_hash text not null check (
    source_hash ~ '^[0-9a-f]{64}$'
  ),
  source_history jsonb not null check (
    jsonb_typeof(source_history) = 'array'
    and jsonb_array_length(source_history) between 1 and 2
  ),
  replacement_count integer not null default 0 check (
    replacement_count between 0 and 1
    and jsonb_array_length(source_history) = replacement_count + 1
  ),
  accepted_body text,
  accepted_body_hash text check (
    accepted_body_hash is null or accepted_body_hash ~ '^[0-9a-f]{64}$'
  ),
  accepted_provenance jsonb,
  attempt_count integer not null default 0 check (attempt_count between 0 and 1000),
  rejection_code text check (
    rejection_code is null or char_length(rejection_code) between 1 and 100
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (batch_id, slot_index),
  constraint modeled_draft_slots_batch_workspace_fkey
    foreign key (batch_id, workspace_id)
    references public.modeled_draft_batches (id, workspace_id)
    on delete cascade,
  constraint modeled_draft_slots_batch_source_unique
    unique (batch_id, source_id),
  constraint modeled_draft_slots_source_history_tail check (
    source_history ->> (jsonb_array_length(source_history) - 1) = source_id
  ),
  constraint modeled_draft_slots_state_shape check (
    (
      state = 'assigned'
      and accepted_body is null
      and accepted_body_hash is null
      and accepted_provenance is null
      and accepted_at is null
    )
    or
    (
      state = 'accepted'
      and accepted_body is not null
      and accepted_body_hash is not null
      and jsonb_typeof(accepted_provenance) = 'object'
      and accepted_at is not null
      and rejection_code is null
    )
  )
);

-- Reapplying this migration must also harden a table created by an earlier
-- draft of migration 107, where source URLs were nullable.
alter table public.modeled_draft_slots
  alter column source_url set not null;
alter table public.modeled_draft_slots
  drop constraint if exists modeled_draft_slots_source_url_check;
alter table public.modeled_draft_slots
  add constraint modeled_draft_slots_source_url_check check (
    char_length(source_url) between 1 and 2048
    and source_url = btrim(source_url)
    and source_url ~ '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'
  );

create unique index if not exists modeled_draft_slots_accepted_body_unique
  on public.modeled_draft_slots (batch_id, accepted_body_hash)
  where state = 'accepted';

create index if not exists modeled_draft_batches_active_lease_idx
  on public.modeled_draft_batches (lease_expires_at)
  where status = 'active';

create index if not exists modeled_draft_batches_retention_idx
  on public.modeled_draft_batches (updated_at, id)
  where status in ('paused', 'completed');

create or replace function public.protect_modeled_draft_batch_invariants()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
    or new.operation_key is distinct from old.operation_key
    or new.request_hash is distinct from old.request_hash
    or new.expected_count is distinct from old.expected_count
    or new.sources is distinct from old.sources
  then
    raise exception 'modeled draft batch request is immutable'
      using errcode = '22023';
  end if;
  if old.status = 'completed' and new is distinct from old then
    raise exception 'completed modeled draft batch is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists modeled_draft_batches_protect_invariants
  on public.modeled_draft_batches;
create trigger modeled_draft_batches_protect_invariants
before update on public.modeled_draft_batches
for each row execute function public.protect_modeled_draft_batch_invariants();

create or replace function public.protect_modeled_draft_slot_invariants()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_expected_count integer;
begin
  if tg_op = 'UPDATE' then
    if new.batch_id is distinct from old.batch_id
      or new.workspace_id is distinct from old.workspace_id
      or new.slot_index is distinct from old.slot_index
    then
      raise exception 'modeled draft slot identity is immutable'
        using errcode = '22023';
    end if;
    if old.state = 'accepted' and new is distinct from old then
      raise exception 'accepted modeled draft slot is immutable'
        using errcode = '55000';
    end if;
  end if;

  select batch.expected_count
  into v_expected_count
  from public.modeled_draft_batches as batch
  where batch.id = new.batch_id
    and batch.workspace_id = new.workspace_id;
  if v_expected_count is null or new.slot_index >= v_expected_count then
    raise exception 'slot index is outside the modeled draft batch contract'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists modeled_draft_slots_protect_invariants
  on public.modeled_draft_slots;
create trigger modeled_draft_slots_protect_invariants
before insert or update on public.modeled_draft_slots
for each row execute function public.protect_modeled_draft_slot_invariants();

create or replace function public.modeled_draft_batch_slots_snapshot(
  p_batch_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'batch_id', slot.batch_id,
        'slot_index', slot.slot_index,
        'state', slot.state,
        'source', jsonb_build_object(
          'id', slot.source_id,
          'url', slot.source_url,
          'title', canonical_source.value ->> 'title',
          'published_at', canonical_source.value ->> 'published_at',
          'text', slot.source_text,
          'hash', slot.source_hash
        ),
        'source_history', slot.source_history,
        'replacement_count', slot.replacement_count,
        'accepted', case
          when slot.accepted_body is null then null
          else jsonb_build_object(
            'body', slot.accepted_body,
            'hash', slot.accepted_body_hash,
            'provenance', slot.accepted_provenance
          )
        end,
        'attempt_count', slot.attempt_count,
        'rejection_code', slot.rejection_code
      ) order by slot.slot_index
    ),
    '[]'::jsonb
  )
  from public.modeled_draft_slots as slot
  join public.modeled_draft_batches as batch
    on batch.id = slot.batch_id
  left join lateral (
    select item.value
    from jsonb_array_elements(batch.sources) as item(value)
    where item.value ->> 'id' = slot.source_id
    limit 1
  ) as canonical_source on true
  where slot.batch_id = p_batch_id;
$$;

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
    or p_expected_count not between 2 and 5
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
      or jsonb_typeof(v_source -> 'url') is distinct from 'string'
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
      or v_source_url is null
      or v_source_url <> btrim(v_source_url)
      or char_length(v_source_url) not between 1 and 2048
      or v_source_url !~ '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'
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
    or p_slot_index not between 0 and 4
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

create or replace function public.complete_modeled_draft_batch(
  p_workspace_id text,
  p_batch_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_batch public.modeled_draft_batches%rowtype;
  v_slots jsonb;
begin
  if p_workspace_id is null
    or p_workspace_id <> btrim(p_workspace_id)
    or char_length(p_workspace_id) not between 1 and 255
    or p_batch_id is null
    or p_lease_token is null
  then
    raise exception 'invalid modeled draft batch completion'
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

  if v_batch.status = 'completed' then
    if v_batch.completed_by_token is distinct from p_lease_token then
      raise exception 'modeled draft batch completion token mismatch'
        using errcode = '55000';
    end if;
    return jsonb_build_object(
      'status', 'completed',
      'batch_id', v_batch.id,
      'expected_count', v_batch.expected_count,
      'completed_at', v_batch.completed_at,
      'sources', v_batch.sources,
      'slots', public.modeled_draft_batch_slots_snapshot(v_batch.id)
    );
  end if;

  if v_batch.status <> 'active'
    or v_batch.lease_token is distinct from p_lease_token
    or v_batch.lease_expires_at <= clock_timestamp()
  then
    raise exception 'modeled draft batch lease is not active'
      using errcode = '55000';
  end if;

  if (
    select count(*)
    from public.modeled_draft_slots as slot
    where slot.batch_id = p_batch_id
  ) <> v_batch.expected_count
    or exists (
      select 1
      from generate_series(0, v_batch.expected_count - 1) as required(slot_index)
      left join public.modeled_draft_slots as slot
        on slot.batch_id = p_batch_id
       and slot.slot_index = required.slot_index
      where slot.slot_index is null or slot.state <> 'accepted'
    )
    or exists (
      select 1
      from public.modeled_draft_slots as slot
      where slot.batch_id = p_batch_id
        and (
          slot.accepted_body_hash is distinct from
            encode(public.digest(slot.accepted_body, 'sha256'), 'hex')
          or slot.source_hash is distinct from
            encode(public.digest(slot.source_text, 'sha256'), 'hex')
          or (slot.accepted_provenance ->> 'kind') is distinct from 'modeled'
          or (slot.accepted_provenance ->> 'source_id') is distinct from slot.source_id
          or (slot.accepted_provenance ->> 'source_hash') is distinct from slot.source_hash
          or (slot.accepted_provenance ->> 'source_url') is distinct from slot.source_url
        )
    )
    or exists (
      select history.source_id
      from public.modeled_draft_slots as slot
      cross join lateral jsonb_array_elements_text(slot.source_history) as history(source_id)
      where slot.batch_id = p_batch_id
      group by history.source_id
      having count(*) > 1
    )
  then
    raise exception 'modeled draft batch is not an exact valid accepted set'
      using errcode = '23514';
  end if;

  update public.modeled_draft_batches as batch
  set status = 'completed',
      lease_token = null,
      lease_expires_at = null,
      pause_reason = null,
      completed_by_token = p_lease_token,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where batch.id = p_batch_id
  returning batch.* into v_batch;

  v_slots := public.modeled_draft_batch_slots_snapshot(p_batch_id);
  return jsonb_build_object(
    'status', 'completed',
    'batch_id', v_batch.id,
    'expected_count', v_batch.expected_count,
    'completed_at', v_batch.completed_at,
    'sources', v_batch.sources,
    'slots', v_slots
  );
end;
$$;

create or replace function public.release_modeled_draft_batch(
  p_workspace_id text,
  p_batch_id uuid,
  p_lease_token uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_batch public.modeled_draft_batches%rowtype;
begin
  if p_workspace_id is null
    or p_workspace_id <> btrim(p_workspace_id)
    or char_length(p_workspace_id) not between 1 and 255
    or p_batch_id is null
    or p_lease_token is null
    or p_reason not in (
      'cancelled',
      'deadline',
      'reviewer_unavailable',
      'writer_unavailable',
      'slot_exhausted',
      'source_pool_exhausted',
      'protocol_error',
      'store_unavailable'
    )
  then
    raise exception 'invalid modeled draft batch release'
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
  if v_batch.status = 'completed' then
    if v_batch.completed_by_token is distinct from p_lease_token then
      raise exception 'modeled draft batch completion token mismatch'
        using errcode = '55000';
    end if;
    return jsonb_build_object(
      'status', 'completed',
      'batch_id', v_batch.id,
      'expected_count', v_batch.expected_count,
      'completed_at', v_batch.completed_at,
      'sources', v_batch.sources,
      'slots', public.modeled_draft_batch_slots_snapshot(v_batch.id)
    );
  end if;
  if v_batch.status <> 'active'
    or v_batch.lease_token is distinct from p_lease_token
  then
    raise exception 'modeled draft batch lease is not owned by this caller'
      using errcode = '55000';
  end if;

  update public.modeled_draft_batches as batch
  set status = 'paused',
      lease_token = null,
      lease_expires_at = null,
      pause_reason = p_reason,
      updated_at = clock_timestamp()
  where batch.id = p_batch_id
  returning batch.* into v_batch;

  return jsonb_build_object(
    'status', 'paused',
    'batch_id', v_batch.id,
    'reason', v_batch.pause_reason,
    'expected_count', v_batch.expected_count,
    'sources', v_batch.sources,
    'slots', public.modeled_draft_batch_slots_snapshot(v_batch.id)
  );
end;
$$;

create or replace function public.purge_expired_modeled_draft_batches(
  p_retention_seconds integer default 604800,
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
  v_now timestamptz;
begin
  if p_retention_seconds is null
    or p_retention_seconds not between 86400 and 2592000
    or p_limit is null
    or p_limit not between 1 and 1000
  then
    raise exception 'invalid modeled draft batch retention bounds'
      using errcode = '22023';
  end if;

  v_now := clock_timestamp();

  with candidates as (
    select batch.id
    from public.modeled_draft_batches as batch
    where (
        batch.status in ('paused', 'completed')
        or (
          batch.status = 'active'
          and batch.lease_expires_at <= v_now
        )
      )
      and batch.updated_at < v_now - make_interval(secs => p_retention_seconds)
    order by batch.updated_at, batch.id
    limit p_limit
    for update skip locked
  ), deleted as (
    delete from public.modeled_draft_batches as batch
    using candidates
    where batch.id = candidates.id
    returning batch.id
  )
  select count(*)::integer into v_deleted from deleted;

  return v_deleted;
end;
$$;

alter table public.modeled_draft_batches enable row level security;
alter table public.modeled_draft_slots enable row level security;

revoke all on table public.modeled_draft_batches
  from public, anon, authenticated, service_role;
revoke all on table public.modeled_draft_slots
  from public, anon, authenticated, service_role;
grant select, delete on table public.modeled_draft_batches to service_role;
grant select, delete on table public.modeled_draft_slots to service_role;

revoke all on function public.protect_modeled_draft_batch_invariants()
  from public, anon, authenticated, service_role;
revoke all on function public.protect_modeled_draft_slot_invariants()
  from public, anon, authenticated, service_role;
revoke all on function public.modeled_draft_batch_slots_snapshot(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_modeled_draft_batch(
  text, text, text, integer, jsonb, integer
) from public, anon, authenticated, service_role;
revoke all on function public.checkpoint_modeled_draft_slot(
  text, uuid, uuid, integer, text, text, text, text, jsonb, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.complete_modeled_draft_batch(text, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.release_modeled_draft_batch(text, uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.purge_expired_modeled_draft_batches(integer, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_modeled_draft_batch(
  text, text, text, integer, jsonb, integer
) to service_role;
grant execute on function public.checkpoint_modeled_draft_slot(
  text, uuid, uuid, integer, text, text, text, text, jsonb, text, integer, integer
) to service_role;
grant execute on function public.complete_modeled_draft_batch(text, uuid, uuid)
  to service_role;
grant execute on function public.release_modeled_draft_batch(text, uuid, uuid, text)
  to service_role;
grant execute on function public.purge_expired_modeled_draft_batches(integer, integer)
  to service_role;

-- Preserve every readiness check from migration 106 and extend it without
-- duplicating that large fingerprint. The rename happens once; rerunning this
-- migration replaces only the public wrapper.
do $$
begin
  if to_regprocedure('public.app_deployment_readiness_pre_107()') is null then
    execute 'alter function public.app_deployment_readiness() rename to app_deployment_readiness_pre_107';
  end if;
end;
$$;

revoke all on function public.app_deployment_readiness_pre_107()
  from public, anon, authenticated, service_role;

create or replace function public.app_deployment_readiness()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  with base as (
    select public.app_deployment_readiness_pre_107() as value
  ), required_functions(signature) as (
    values
      ('claim_modeled_draft_batch(text,text,text,integer,jsonb,integer)'),
      ('checkpoint_modeled_draft_slot(text,uuid,uuid,integer,text,text,text,text,jsonb,text,integer,integer)'),
      ('complete_modeled_draft_batch(text,uuid,uuid)'),
      ('release_modeled_draft_batch(text,uuid,uuid,text)'),
      ('purge_expired_modeled_draft_batches(integer,integer)')
  ), missing_functions(name) as (
    select signature
    from required_functions
    where to_regprocedure('public.' || signature) is null
  ), required_relations(name) as (
    values
      ('public.modeled_draft_batches'),
      ('public.modeled_draft_slots'),
      ('public.modeled_draft_batches_retention_idx')
  ), missing_relations(name) as (
    select name
    from required_relations
    where to_regclass(name) is null
  ), required_rls(name) as (
    values
      ('public.modeled_draft_batches'),
      ('public.modeled_draft_slots')
  ), missing_rls(name) as (
    select required.name || '(RLS enabled)'
    from required_rls as required
    left join pg_class as relation
      on relation.oid = to_regclass(required.name)
    where relation.oid is null or not relation.relrowsecurity
  ), required_service_functions(signature) as (
    values
      ('claim_modeled_draft_batch(text,text,text,integer,jsonb,integer)'),
      ('checkpoint_modeled_draft_slot(text,uuid,uuid,integer,text,text,text,text,jsonb,text,integer,integer)'),
      ('complete_modeled_draft_batch(text,uuid,uuid)'),
      ('release_modeled_draft_batch(text,uuid,uuid,text)'),
      ('purge_expired_modeled_draft_batches(integer,integer)')
  ), missing_service_execute(name) as (
    select signature || '(service_role execute)'
    from required_service_functions
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
    from required_service_functions
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
  ), required_triggers(name, relation_name, function_signature) as (
    values
      (
        'modeled_draft_batches_protect_invariants',
        'public.modeled_draft_batches',
        'public.protect_modeled_draft_batch_invariants()'
      ),
      (
        'modeled_draft_slots_protect_invariants',
        'public.modeled_draft_slots',
        'public.protect_modeled_draft_slot_invariants()'
      )
  ), missing_triggers(name) as (
    select required.name || '(trigger enabled)'
    from required_triggers as required
    where not exists (
      select 1
      from pg_trigger as trigger
      where trigger.tgrelid = to_regclass(required.relation_name)
        and trigger.tgname = required.name
        and not trigger.tgisinternal
        and trigger.tgenabled in ('O', 'A')
        and trigger.tgfoid = to_regprocedure(required.function_signature)
    )
  ), new_missing(name) as (
    select name from missing_functions
    union all select name from missing_relations
    union all select name from missing_rls
    union all select name from missing_service_execute
    union all select name from unsafe_function_execute
    union all select name from missing_triggers
  ), all_missing(name) as (
    select existing.value::text
    from base,
      lateral jsonb_array_elements_text(
        coalesce(base.value -> 'missing_capabilities', '[]'::jsonb)
      ) as existing(value)
    union all
    select name from new_missing
  )
  select jsonb_build_object(
    'applied_version', coalesce(
      (select version from public.app_schema_version where singleton),
      0
    ),
    'compatible',
      coalesce((base.value ->> 'compatible')::boolean, false)
      and not exists (select 1 from new_missing),
    'missing_capabilities', coalesce(
      (select jsonb_agg(distinct name order by name) from all_missing),
      '[]'::jsonb
    )
  )
  from base;
$$;

revoke all on function public.app_deployment_readiness()
  from public, anon, authenticated, service_role;
grant execute on function public.app_deployment_readiness() to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 107, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
