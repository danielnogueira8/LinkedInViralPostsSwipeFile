-- Durable, leased checkpoints for Cowork saved-draft mutations.
--
-- A model/provider retry may rebuild an action plan, but it must never blindly
-- replay a side effect. The server owns the semantic operation key and records
-- each action before execution. Terminal checkpoints are immutable; expired
-- running leases may be reclaimed and reconciled against current draft state.

begin;

-- A browser-generated identity exists before SSE headers, so Stop can fence a
-- turn even while server setup is still running. It is replaced on every claim
-- and cleared with the claim; delayed Stop requests therefore cannot touch a
-- replacement turn.
alter table public.chats
  add column if not exists client_turn_id uuid;

-- Keep the browser identity on the persisted user row too. The active chat
-- claim clears its identity when the turn settles, but a client that never
-- received SSE headers still needs an exact durable lineage to reconcile a
-- completed turn without falling back to prompt text.
alter table public.chat_messages
  add column if not exists client_turn_id uuid,
  add column if not exists transport_recovery_requested_at timestamptz,
  add column if not exists user_stop_requested_at timestamptz,
  add column if not exists terminal_reason text check (
    terminal_reason is null or
    terminal_reason in ('done', 'ask', 'cancelled', 'deadline', 'error')
  );

create unique index if not exists chat_messages_client_turn_idx
  on public.chat_messages (chat_id, client_turn_id)
  where client_turn_id is not null;

-- Persist a typed terminal outcome alongside the assistant row. The durable
-- transport-recovery marker lives on the exact user row; this paired outcome
-- lets Retry distinguish a cancelled partial response from a late successful
-- completion without inspecting English copy.
create or replace function public.persist_chat_assistant_turn(
  p_chat_id uuid,
  p_workspace_id text,
  p_content text,
  p_tool_calls jsonb,
  p_artifacts jsonb,
  p_input_tokens integer,
  p_output_tokens integer,
  p_tool_messages jsonb,
  p_terminal_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assistant_id uuid;
begin
  if p_terminal_reason not in ('done', 'ask', 'cancelled', 'deadline', 'error') then
    raise exception 'invalid assistant terminal reason';
  end if;
  v_assistant_id := public.persist_chat_assistant_turn(
    p_chat_id,
    p_workspace_id,
    p_content,
    p_tool_calls,
    p_artifacts,
    p_input_tokens,
    p_output_tokens,
    p_tool_messages
  );
  update public.chat_messages as message
  set terminal_reason = p_terminal_reason
  where message.id = v_assistant_id
    and message.chat_id = p_chat_id
    and message.workspace_id = p_workspace_id
    and message.role = 'assistant';
  return v_assistant_id;
end;
$$;

revoke all on function public.persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb, text
) from public, anon, authenticated;
grant execute on function public.persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb, text
) to service_role;

create index if not exists chats_active_client_turn_idx
  on public.chats (workspace_id, id, client_turn_id)
  where turn_started_at is not null and client_turn_id is not null;

create or replace function public.clear_replaced_chat_client_turn_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.turn_started_at is distinct from old.turn_started_at then
    new.client_turn_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists chats_clear_replaced_client_turn_id on public.chats;
create trigger chats_clear_replaced_client_turn_id
before update of turn_started_at on public.chats
for each row execute function public.clear_replaced_chat_client_turn_id();

-- Preserve the existing nine-argument claim during a rolling deploy. The
-- wrapper runs it inside this same transaction (so its advisory locks remain
-- held), then binds the client identity before returning the successful claim.
create or replace function public.claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_client_turn_id uuid,
  p_hourly_limit integer,
  p_daily_limit integer,
  p_monthly_limit integer default 2147483647,
  p_turn_timeout_secs integer default 330,
  p_budget_usd numeric default 0,
  p_turn_cost_estimate numeric default 0.05
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
    p_turn_cost_estimate
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

create or replace function public.release_chat_turn_workspace_cost(
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
  if p_operation_key is null or btrim(p_operation_key) = '' then return; end if;
  select chat.turn_cost_operation_key
  into v_operation_key
  from public.chats as chat
  where chat.id = p_chat_id
    and chat.workspace_id = p_workspace_id
    and chat.turn_cost_operation_key = p_operation_key
  for update;
  if not found then return; end if;

  update public.chats as chat
  set turn_started_at = null,
      turn_cost_operation_key = null,
      client_turn_id = null
  where chat.id = p_chat_id
    and chat.workspace_id = p_workspace_id
    and chat.turn_cost_operation_key = p_operation_key;
  perform public.release_workspace_cost(p_workspace_id, v_operation_key);
end;
$$;

create table if not exists public.chat_action_checkpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  chat_id uuid not null references public.chats(id) on delete cascade,
  turn_message_id uuid not null references public.chat_messages(id) on delete cascade,
  operation_key text not null check (
    char_length(operation_key) between 1 and 200
  ),
  action_type text not null check (
    action_type in ('move_on_board', 'schedule_post')
  ),
  target_id uuid not null,
  arguments jsonb not null default '{}'::jsonb,
  status text not null default 'running' check (
    status in ('running', 'committed', 'failed', 'cancelled')
  ),
  result jsonb,
  error_code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, operation_key),
  check (
    (
      status = 'running'
      and lease_token is not null
      and lease_expires_at is not null
      and completed_at is null
      and result is null
      and error_code is null
    )
    or
    (
      status <> 'running'
      and lease_token is null
      and lease_expires_at is null
      and completed_at is not null
      and result is not null
    )
  )
);

create index if not exists chat_action_checkpoints_turn_idx
  on public.chat_action_checkpoints (
    workspace_id,
    chat_id,
    turn_message_id,
    created_at
  );

create index if not exists chat_action_checkpoints_running_lease_idx
  on public.chat_action_checkpoints (lease_expires_at)
  where status = 'running';

-- Explicit Retry lineage. A repeated instruction elsewhere in the chat is a
-- new logical action unless the exact user row records this root. The expanded
-- instruction also preserves action context after an AskCard answer such as
-- "Tomorrow" or a selected draft title.
create table if not exists public.chat_action_retry_contexts (
  user_message_id uuid primary key
    references public.chat_messages(id) on delete cascade,
  workspace_id text not null,
  chat_id uuid not null references public.chats(id) on delete cascade,
  root_turn_message_id uuid not null
    references public.chat_messages(id) on delete cascade,
  effective_instruction text not null check (
    char_length(effective_instruction) between 1 and 50000
  ),
  route jsonb not null check (
    jsonb_typeof(route) = 'object'
    and route->>'kind' in (
      'action_management',
      'clarify_action',
      'no_action',
      'disallowed_action'
    )
  ),
  confirmed_target_ids uuid[] not null default '{}'::uuid[] check (
    cardinality(confirmed_target_ids) <= 3
  ),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, chat_id, user_message_id)
);

create index if not exists chat_action_retry_contexts_root_idx
  on public.chat_action_retry_contexts (
    workspace_id,
    chat_id,
    root_turn_message_id
  );

-- A turn-level tombstone is the durable Stop fence. Checkpoint claims and
-- executions take the same advisory lock and consult this row, so a cancelled
-- turn can never acquire a fresh lease or roll forward after lease expiry.
create table if not exists public.chat_action_turn_controls (
  workspace_id text not null,
  chat_id uuid not null references public.chats(id) on delete cascade,
  turn_message_id uuid not null
    references public.chat_messages(id) on delete cascade,
  cancelled_at timestamptz not null default now(),
  reason text not null check (char_length(reason) between 1 and 80),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, turn_message_id)
);

create index if not exists chat_action_turn_controls_chat_idx
  on public.chat_action_turn_controls (workspace_id, chat_id, cancelled_at);

alter table public.chat_action_checkpoints enable row level security;
alter table public.chat_action_retry_contexts enable row level security;
alter table public.chat_action_turn_controls enable row level security;

drop policy if exists chat_action_checkpoints_isolation
  on public.chat_action_checkpoints;
create policy chat_action_checkpoints_isolation
  on public.chat_action_checkpoints
  using (workspace_id = public.auth_workspace_id())
  with check (workspace_id = public.auth_workspace_id());

drop policy if exists chat_action_retry_contexts_isolation
  on public.chat_action_retry_contexts;
create policy chat_action_retry_contexts_isolation
  on public.chat_action_retry_contexts
  using (workspace_id = public.auth_workspace_id())
  with check (workspace_id = public.auth_workspace_id());

drop policy if exists chat_action_turn_controls_isolation
  on public.chat_action_turn_controls;
create policy chat_action_turn_controls_isolation
  on public.chat_action_turn_controls
  using (workspace_id = public.auth_workspace_id())
  with check (workspace_id = public.auth_workspace_id());

create or replace function public.save_chat_action_retry_context(
  p_workspace_id text,
  p_chat_id uuid,
  p_user_message_id uuid,
  p_root_turn_message_id uuid,
  p_effective_instruction text,
  p_route jsonb,
  p_confirmed_target_ids uuid[] default '{}'::uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.chat_action_retry_contexts%rowtype;
  v_cancelled_at timestamptz;
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_chat_id is null or p_user_message_id is null or p_root_turn_message_id is null then
    raise exception 'chat, user message, and retry root are required';
  end if;
  if p_effective_instruction is null
    or char_length(btrim(p_effective_instruction)) < 1
    or char_length(p_effective_instruction) > 50000 then
    raise exception 'effective action instruction is invalid';
  end if;
  if p_route is null
    or jsonb_typeof(p_route) <> 'object'
    or p_route->>'kind' not in (
      'action_management',
      'clarify_action',
      'no_action',
      'disallowed_action'
    ) then
    raise exception 'normalized action route is invalid';
  end if;
  if p_route->>'kind' = 'action_management'
    and (
      jsonb_typeof(p_route->'targetCount') <> 'number'
      or (p_route->>'targetCount')::integer not between 1 and 3
      or jsonb_typeof(p_route->'requirements') <> 'array'
      or jsonb_array_length(p_route->'requirements') not between 1 and 2
    ) then
    raise exception 'normalized action management route is invalid';
  end if;
  p_confirmed_target_ids := coalesce(p_confirmed_target_ids, '{}'::uuid[]);
  if cardinality(p_confirmed_target_ids) > 3
    or cardinality(p_confirmed_target_ids) <> (
      select count(distinct target_id)
      from unnest(p_confirmed_target_ids) as target_id
    ) then
    raise exception 'confirmed action targets are invalid';
  end if;
  if cardinality(p_confirmed_target_ids) > 0
    and p_route->>'kind' <> 'action_management' then
    raise exception 'confirmed targets require an action management route';
  end if;
  if cardinality(p_confirmed_target_ids) > 0
    and cardinality(p_confirmed_target_ids) <> (p_route->>'targetCount')::integer then
    raise exception 'confirmed action target count does not match route';
  end if;
  if not exists (
    select 1
    from public.chats as chat
    where chat.id = p_chat_id
      and chat.workspace_id = p_workspace_id
  ) then
    raise exception 'chat does not belong to workspace';
  end if;
  if not exists (
    select 1
    from public.chat_messages as message
    where message.id = p_user_message_id
      and message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user'
  ) then
    raise exception 'retry user message does not belong to chat and workspace';
  end if;
  if not exists (
    select 1
    from public.chat_messages as message
    where message.id = p_root_turn_message_id
      and message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user'
  ) then
    raise exception 'retry root does not belong to chat and workspace';
  end if;
  if exists (
    select 1
    from unnest(p_confirmed_target_ids) as confirmed(target_id)
    where not exists (
      select 1
      from public.chat_artifacts as draft
      where draft.id = confirmed.target_id
        and draft.workspace_id = p_workspace_id
    )
  ) then
    raise exception 'confirmed action target does not belong to workspace';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'chat_action_turn:' || p_workspace_id || ':' || p_root_turn_message_id::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('chat_action_retry:' || p_workspace_id || ':' || p_user_message_id::text, 0)
  );
  select control.cancelled_at
  into v_cancelled_at
  from public.chat_action_turn_controls as control
  where control.workspace_id = p_workspace_id
    and control.chat_id = p_chat_id
    and control.turn_message_id = p_root_turn_message_id;
  select context.*
  into v_existing
  from public.chat_action_retry_contexts as context
  where context.user_message_id = p_user_message_id
  for update;

  if found then
    if v_existing.workspace_id <> p_workspace_id
      or v_existing.chat_id <> p_chat_id
      or v_existing.root_turn_message_id <> p_root_turn_message_id
      or v_existing.effective_instruction <> p_effective_instruction
      or v_existing.route <> p_route
      or v_existing.confirmed_target_ids <> p_confirmed_target_ids then
      raise exception 'retry context cannot be rebound';
    end if;
    if v_cancelled_at is not null and v_existing.cancelled_at is null then
      update public.chat_action_retry_contexts as context
      set cancelled_at = v_cancelled_at,
          updated_at = clock_timestamp()
      where context.user_message_id = p_user_message_id;
    end if;
    return;
  end if;

  insert into public.chat_action_retry_contexts (
    user_message_id,
    workspace_id,
    chat_id,
    root_turn_message_id,
    effective_instruction,
    route,
    confirmed_target_ids,
    cancelled_at
  ) values (
    p_user_message_id,
    p_workspace_id,
    p_chat_id,
    p_root_turn_message_id,
    p_effective_instruction,
    p_route,
    p_confirmed_target_ids,
    v_cancelled_at
  );
end;
$$;

create or replace function public.cancel_chat_action_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_turn_message_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_chat_id is null or p_turn_message_id is null then
    raise exception 'chat and action turn ids are required';
  end if;
  if p_reason is null
    or char_length(btrim(p_reason)) < 1
    or char_length(p_reason) > 80 then
    raise exception 'action cancellation reason is invalid';
  end if;
  if not exists (
    select 1
    from public.chat_messages as message
    where message.id = p_turn_message_id
      and message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user'
  ) then
    raise exception 'action turn does not belong to chat and workspace';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'chat_action_turn:' || p_workspace_id || ':' || p_turn_message_id::text,
      0
    )
  );

  insert into public.chat_action_turn_controls (
    workspace_id,
    chat_id,
    turn_message_id,
    cancelled_at,
    reason,
    updated_at
  ) values (
    p_workspace_id,
    p_chat_id,
    p_turn_message_id,
    clock_timestamp(),
    btrim(p_reason),
    clock_timestamp()
  )
  on conflict (workspace_id, turn_message_id) do update
  set reason = excluded.reason,
      updated_at = clock_timestamp();

  update public.chat_action_retry_contexts as context
  set cancelled_at = coalesce(context.cancelled_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where context.workspace_id = p_workspace_id
    and context.chat_id = p_chat_id
    and context.root_turn_message_id = p_turn_message_id;

  update public.chat_action_checkpoints as checkpoint
  set status = 'cancelled',
      result = jsonb_build_object('ok', false, 'cancelled', true),
      error_code = 'turn_cancelled',
      lease_token = null,
      lease_expires_at = null,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where checkpoint.workspace_id = p_workspace_id
    and checkpoint.chat_id = p_chat_id
    and checkpoint.turn_message_id = p_turn_message_id
    and checkpoint.status = 'running';
end;
$$;

-- Claims happen before execution. If a later claim fails, this atomically
-- removes the wholly unexecuted lease set so an explicit Retry can compile and
-- claim the complete plan again. Any committed/failed result or Stop tombstone
-- makes reset illegal.
create or replace function public.reset_uncommitted_chat_action_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_turn_message_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_chat_id is null or p_turn_message_id is null then
    raise exception 'chat and action turn ids are required';
  end if;
  if not exists (
    select 1
    from public.chat_messages as message
    where message.id = p_turn_message_id
      and message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user'
  ) then
    raise exception 'action turn does not belong to chat and workspace';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'chat_action_turn:' || p_workspace_id || ':' || p_turn_message_id::text,
      0
    )
  );
  if exists (
    select 1
    from public.chat_action_turn_controls as control
    where control.workspace_id = p_workspace_id
      and control.chat_id = p_chat_id
      and control.turn_message_id = p_turn_message_id
  ) then
    raise exception 'cancelled action turn cannot be reset';
  end if;
  if exists (
    select 1
    from public.chat_action_checkpoints as checkpoint
    where checkpoint.workspace_id = p_workspace_id
      and checkpoint.chat_id = p_chat_id
      and checkpoint.turn_message_id = p_turn_message_id
      and checkpoint.status in ('committed', 'failed')
  ) then
    raise exception 'executed action turn cannot be reset';
  end if;

  delete from public.chat_action_checkpoints as checkpoint
  where checkpoint.workspace_id = p_workspace_id
    and checkpoint.chat_id = p_chat_id
    and checkpoint.turn_message_id = p_turn_message_id
    and checkpoint.status in ('running', 'cancelled');
end;
$$;

-- A recoverable transport/deadline interruption must not wait for the original
-- 120-second leases. The turn lock serializes with atomic execution: any
-- in-flight mutation settles first, then only untouched running leases become
-- immediately reclaimable by the same logical Retry.
create or replace function public.release_chat_action_turn_leases(
  p_workspace_id text,
  p_chat_id uuid,
  p_turn_message_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_chat_id is null or p_turn_message_id is null then
    raise exception 'chat and action turn ids are required';
  end if;
  if not exists (
    select 1
    from public.chat_messages as message
    where message.id = p_turn_message_id
      and message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user'
  ) then
    raise exception 'action turn does not belong to chat and workspace';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'chat_action_turn:' || p_workspace_id || ':' || p_turn_message_id::text,
      0
    )
  );
  if exists (
    select 1
    from public.chat_action_turn_controls as control
    where control.workspace_id = p_workspace_id
      and control.chat_id = p_chat_id
      and control.turn_message_id = p_turn_message_id
  ) then
    raise exception 'cancelled action turn cannot release leases';
  end if;

  update public.chat_action_checkpoints as checkpoint
  set lease_expires_at = clock_timestamp() - interval '1 microsecond',
      updated_at = clock_timestamp()
  where checkpoint.workspace_id = p_workspace_id
    and checkpoint.chat_id = p_chat_id
    and checkpoint.turn_message_id = p_turn_message_id
    and checkpoint.status = 'running';
end;
$$;

-- The authenticated app route calls this through the repo's service-role
-- client after requireWorkspaceId(). The exact workspace and active-turn
-- timestamp still bind the write. The chat cancel flag and action tombstone
-- land in one transaction, so a process crash immediately after Stop cannot
-- leave a resumable action lease.
create or replace function public.cancel_active_chat_action_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_turn_started_at timestamptz,
  p_reason text default 'user_stop',
  p_client_turn_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat public.chats%rowtype;
  v_active_turn boolean := false;
  v_user_message_id uuid;
  v_user_message_created_at timestamptz;
  v_root_turn_message_id uuid;
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_chat_id is null or (
    p_turn_started_at is null and p_client_turn_id is null
  ) then
    raise exception 'chat and active turn identity are required';
  end if;
  if p_reason not in ('user_stop', 'transport_recovery') then
    raise exception 'active turn cancellation reason is invalid';
  end if;

  select chat.*
  into v_chat
  from public.chats as chat
  where chat.id = p_chat_id
    and chat.workspace_id = p_workspace_id
    and chat.archived_at is null
    and (
      p_turn_started_at is null
      or chat.turn_started_at = p_turn_started_at
    )
    and (
      p_client_turn_id is null
      or chat.client_turn_id = p_client_turn_id
  )
  for update;
  v_active_turn := found;

  if v_active_turn then
    update public.chats as chat
    set cancel_requested_at = clock_timestamp()
    where chat.id = p_chat_id
      and chat.workspace_id = p_workspace_id;
  end if;

  if p_client_turn_id is not null then
    select message.id, message.created_at
    into v_user_message_id, v_user_message_created_at
    from public.chat_messages as message
    where message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user'
      and message.client_turn_id = p_client_turn_id;
  elsif v_active_turn then
    select message.id, message.created_at
    into v_user_message_id, v_user_message_created_at
    from public.chat_messages as message
    where message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user'
    order by message.created_at desc, message.id desc
    limit 1;
  end if;
  if v_user_message_id is null then return v_active_turn; end if;
  if not v_active_turn and p_reason = 'user_stop' and exists (
    select 1
    from public.chat_messages as assistant
    where assistant.chat_id = p_chat_id
      and assistant.workspace_id = p_workspace_id
      and assistant.role = 'assistant'
      and assistant.created_at > v_user_message_created_at
      and assistant.terminal_reason in ('done', 'ask')
      and not (
        coalesce(assistant.tool_calls, '[]'::jsonb) @>
        '[{"function":{"name":"_recoverable"}}]'::jsonb
      )
      and not exists (
        select 1
        from public.chat_messages as later_user
        where later_user.chat_id = p_chat_id
          and later_user.workspace_id = p_workspace_id
          and later_user.role = 'user'
          and later_user.created_at > v_user_message_created_at
          and later_user.created_at < assistant.created_at
      )
  ) then
    return false;
  end if;

  select context.root_turn_message_id
  into v_root_turn_message_id
  from public.chat_action_retry_contexts as context
  where context.workspace_id = p_workspace_id
    and context.chat_id = p_chat_id
    and context.user_message_id = v_user_message_id;
  v_root_turn_message_id := coalesce(
    v_root_turn_message_id,
    v_user_message_id
  );
  if p_reason = 'user_stop' then
    update public.chat_messages as message
    set user_stop_requested_at = coalesce(
      message.user_stop_requested_at,
      clock_timestamp()
    )
    where message.id = v_user_message_id
      and message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user';
  end if;
  if p_reason = 'transport_recovery' then
    update public.chat_messages as message
    set transport_recovery_requested_at = coalesce(
      message.transport_recovery_requested_at,
      clock_timestamp()
    )
    where message.id = v_user_message_id
      and message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id;
    if v_root_turn_message_id is not null and not exists (
      select 1
      from public.chat_action_turn_controls as control
      where control.workspace_id = p_workspace_id
        and control.chat_id = p_chat_id
        and control.turn_message_id = v_root_turn_message_id
    ) then
      perform public.release_chat_action_turn_leases(
        p_workspace_id,
        p_chat_id,
        v_root_turn_message_id
      );
    end if;
    return true;
  end if;
  perform public.cancel_chat_action_turn(
    p_workspace_id,
    p_chat_id,
    v_root_turn_message_id,
    p_reason
  );
  update public.chat_messages as assistant
  set tool_calls = (
    select coalesce(
      jsonb_agg(entry.value order by entry.ordinality),
      '[]'::jsonb
    )
    from jsonb_array_elements(
      coalesce(assistant.tool_calls, '[]'::jsonb)
    ) with ordinality as entry(value, ordinality)
    where entry.value #>> '{function,name}' is distinct from '_recoverable'
  )
  where assistant.chat_id = p_chat_id
    and assistant.workspace_id = p_workspace_id
    and assistant.role = 'assistant'
    and assistant.created_at > v_user_message_created_at
    and coalesce(assistant.tool_calls, '[]'::jsonb) @>
      '[{"function":{"name":"_recoverable"}}]'::jsonb
    and not exists (
      select 1
      from public.chat_messages as later_user
      where later_user.chat_id = p_chat_id
        and later_user.workspace_id = p_workspace_id
        and later_user.role = 'user'
        and later_user.created_at > v_user_message_created_at
        and later_user.created_at < assistant.created_at
    );
  return true;
end;
$$;

create or replace function public.claim_chat_action_checkpoint(
  p_workspace_id text,
  p_chat_id uuid,
  p_turn_message_id uuid,
  p_operation_key text,
  p_action_type text,
  p_target_id uuid,
  p_arguments jsonb,
  p_lease_seconds integer
)
returns table (
  id uuid,
  workspace_id text,
  chat_id uuid,
  turn_message_id uuid,
  operation_key text,
  action_type text,
  target_id uuid,
  arguments jsonb,
  status text,
  result jsonb,
  error_code text,
  owned boolean,
  lease_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation_key text;
  v_checkpoint public.chat_action_checkpoints%rowtype;
  v_lease_token uuid;
  v_checkpoint_found boolean := false;
  v_cancelled boolean := false;
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_chat_id is null or p_turn_message_id is null then
    raise exception 'chat and turn message ids are required';
  end if;
  if p_operation_key is null or btrim(p_operation_key) = '' then
    raise exception 'operation key is required';
  end if;
  if char_length(p_operation_key) > 200 then
    raise exception 'operation key exceeds 200 characters';
  end if;
  if p_action_type not in ('move_on_board', 'schedule_post') then
    raise exception 'unsupported chat action type';
  end if;
  if p_target_id is null then
    raise exception 'action target is required';
  end if;
  if p_arguments is null or jsonb_typeof(p_arguments) <> 'object' then
    raise exception 'action arguments must be a JSON object';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 300 then
    raise exception 'action checkpoint lease must be between 1 and 300 seconds';
  end if;

  if not exists (
    select 1
    from public.chats as chat
    where chat.id = p_chat_id
      and chat.workspace_id = p_workspace_id
  ) then
    raise exception 'chat does not belong to workspace';
  end if;
  if not exists (
    select 1
    from public.chat_messages as message
    where message.id = p_turn_message_id
      and message.chat_id = p_chat_id
      and message.workspace_id = p_workspace_id
      and message.role = 'user'
  ) then
    raise exception 'turn message does not belong to chat and workspace';
  end if;

  v_operation_key := btrim(p_operation_key);
  perform pg_advisory_xact_lock(
    hashtextextended(
      'chat_action_turn:' || p_workspace_id || ':' || p_turn_message_id::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id || ':' || v_operation_key, 0)
  );

  select checkpoint.*
  into v_checkpoint
  from public.chat_action_checkpoints as checkpoint
  where checkpoint.workspace_id = p_workspace_id
    and checkpoint.operation_key = v_operation_key
  for update;
  v_checkpoint_found := found;

  select exists (
    select 1
    from public.chat_action_turn_controls as control
    where control.workspace_id = p_workspace_id
      and control.chat_id = p_chat_id
      and control.turn_message_id = p_turn_message_id
  ) into v_cancelled;

  if v_checkpoint_found then
    if v_checkpoint.chat_id <> p_chat_id
      or v_checkpoint.turn_message_id <> p_turn_message_id
      or v_checkpoint.action_type <> p_action_type
      or v_checkpoint.target_id <> p_target_id
      or v_checkpoint.arguments <> p_arguments then
      raise exception 'operation key was reused with different action semantics';
    end if;
  end if;

  if v_cancelled then
    if v_checkpoint_found and v_checkpoint.status = 'running' then
      update public.chat_action_checkpoints as checkpoint
      set status = 'cancelled',
          result = jsonb_build_object('ok', false, 'cancelled', true),
          error_code = 'turn_cancelled',
          lease_token = null,
          lease_expires_at = null,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where checkpoint.id = v_checkpoint.id
      returning checkpoint.* into v_checkpoint;
    elsif not v_checkpoint_found then
      insert into public.chat_action_checkpoints (
        workspace_id,
        chat_id,
        turn_message_id,
        operation_key,
        action_type,
        target_id,
        arguments,
        status,
        result,
        error_code,
        completed_at
      ) values (
        p_workspace_id,
        p_chat_id,
        p_turn_message_id,
        v_operation_key,
        p_action_type,
        p_target_id,
        p_arguments,
        'cancelled',
        jsonb_build_object('ok', false, 'cancelled', true),
        'turn_cancelled',
        clock_timestamp()
      )
      returning * into v_checkpoint;
    end if;
    return query
    select
      checkpoint.id,
      checkpoint.workspace_id,
      checkpoint.chat_id,
      checkpoint.turn_message_id,
      checkpoint.operation_key,
      checkpoint.action_type,
      checkpoint.target_id,
      checkpoint.arguments,
      checkpoint.status,
      checkpoint.result,
      checkpoint.error_code,
      false,
      null::uuid
    from public.chat_action_checkpoints as checkpoint
    where checkpoint.id = v_checkpoint.id;
    return;
  end if;

  if v_checkpoint_found then
    if v_checkpoint.status <> 'running'
      or v_checkpoint.lease_expires_at > clock_timestamp() then
      return query
      select
        checkpoint.id,
        checkpoint.workspace_id,
        checkpoint.chat_id,
        checkpoint.turn_message_id,
        checkpoint.operation_key,
        checkpoint.action_type,
        checkpoint.target_id,
        checkpoint.arguments,
        checkpoint.status,
        checkpoint.result,
        checkpoint.error_code,
        false,
        null::uuid
      from public.chat_action_checkpoints as checkpoint
      where checkpoint.id = v_checkpoint.id;
      return;
    end if;

    v_lease_token := gen_random_uuid();
    update public.chat_action_checkpoints as checkpoint
    set
      lease_token = v_lease_token,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
    where checkpoint.id = v_checkpoint.id
    returning checkpoint.* into v_checkpoint;
  else
    v_lease_token := gen_random_uuid();
    insert into public.chat_action_checkpoints (
      workspace_id,
      chat_id,
      turn_message_id,
      operation_key,
      action_type,
      target_id,
      arguments,
      lease_token,
      lease_expires_at
    ) values (
      p_workspace_id,
      p_chat_id,
      p_turn_message_id,
      v_operation_key,
      p_action_type,
      p_target_id,
      p_arguments,
      v_lease_token,
      clock_timestamp() + make_interval(secs => p_lease_seconds)
    )
    returning * into v_checkpoint;
  end if;

  return query
  select
    checkpoint.id,
    checkpoint.workspace_id,
    checkpoint.chat_id,
    checkpoint.turn_message_id,
    checkpoint.operation_key,
    checkpoint.action_type,
    checkpoint.target_id,
    checkpoint.arguments,
    checkpoint.status,
    checkpoint.result,
    checkpoint.error_code,
    true,
    v_lease_token
  from public.chat_action_checkpoints as checkpoint
  where checkpoint.id = v_checkpoint.id;
end;
$$;

create or replace function public.finish_chat_action_checkpoint(
  p_workspace_id text,
  p_operation_key text,
  p_lease_token uuid,
  p_status text,
  p_result jsonb,
  p_error_code text default null
)
returns table (
  id uuid,
  workspace_id text,
  chat_id uuid,
  turn_message_id uuid,
  operation_key text,
  action_type text,
  target_id uuid,
  arguments jsonb,
  status text,
  result jsonb,
  error_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation_key text;
  v_checkpoint public.chat_action_checkpoints%rowtype;
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_operation_key is null or btrim(p_operation_key) = '' then
    raise exception 'operation key is required';
  end if;
  if char_length(p_operation_key) > 200 then
    raise exception 'operation key exceeds 200 characters';
  end if;
  if p_lease_token is null then
    raise exception 'lease token is required';
  end if;
  if p_status not in ('committed', 'failed', 'cancelled') then
    raise exception 'checkpoint finish status must be terminal';
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' then
    raise exception 'checkpoint result must be a JSON object';
  end if;

  v_operation_key := btrim(p_operation_key);
  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id || ':' || v_operation_key, 0)
  );

  select checkpoint.*
  into v_checkpoint
  from public.chat_action_checkpoints as checkpoint
  where checkpoint.workspace_id = p_workspace_id
    and checkpoint.operation_key = v_operation_key
  for update;

  if not found then
    raise exception 'action checkpoint does not exist';
  end if;

  -- A retry after a lost response may finish a terminal row again. Returning
  -- the stored result is safe; terminal outcomes are never rewritten.
  if v_checkpoint.status <> 'running' then
    return query
    select
      checkpoint.id,
      checkpoint.workspace_id,
      checkpoint.chat_id,
      checkpoint.turn_message_id,
      checkpoint.operation_key,
      checkpoint.action_type,
      checkpoint.target_id,
      checkpoint.arguments,
      checkpoint.status,
      checkpoint.result,
      checkpoint.error_code
    from public.chat_action_checkpoints as checkpoint
    where checkpoint.id = v_checkpoint.id;
    return;
  end if;

  if v_checkpoint.lease_token <> p_lease_token then
    raise exception 'action checkpoint lease is not owned by this worker';
  end if;

  update public.chat_action_checkpoints as checkpoint
  set
    status = p_status,
    result = p_result,
    error_code = p_error_code,
    lease_token = null,
    lease_expires_at = null,
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where checkpoint.id = v_checkpoint.id
  returning checkpoint.* into v_checkpoint;

  return query
  select
    checkpoint.id,
    checkpoint.workspace_id,
    checkpoint.chat_id,
    checkpoint.turn_message_id,
    checkpoint.operation_key,
    checkpoint.action_type,
    checkpoint.target_id,
    checkpoint.arguments,
    checkpoint.status,
    checkpoint.result,
    checkpoint.error_code
  from public.chat_action_checkpoints as checkpoint
  where checkpoint.id = v_checkpoint.id;
end;
$$;

-- Fence and commit one saved-draft mutation in the same database transaction
-- as its checkpoint. A stale/expired worker cannot cross this boundary, and a
-- lost HTTP response can only leave a terminal checkpoint—not an unrecorded
-- side effect that a retry might replay.
create or replace function public.execute_chat_action_checkpoint(
  p_workspace_id text,
  p_operation_key text,
  p_lease_token uuid
)
returns table (
  id uuid,
  workspace_id text,
  chat_id uuid,
  turn_message_id uuid,
  operation_key text,
  action_type text,
  target_id uuid,
  arguments jsonb,
  status text,
  result jsonb,
  error_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation_key text;
  v_checkpoint public.chat_action_checkpoints%rowtype;
  v_turn_message_id uuid;
  v_chat_id uuid;
  v_draft public.chat_artifacts%rowtype;
  v_move_status text;
  v_date_text text;
  v_date date;
  v_timezone text;
  v_local_today date;
  v_result jsonb;
  v_terminal_status text := 'committed';
  v_error_code text;
  v_already_satisfied boolean := false;
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace id is required';
  end if;
  if p_operation_key is null or btrim(p_operation_key) = '' then
    raise exception 'operation key is required';
  end if;
  if char_length(p_operation_key) > 200 then
    raise exception 'operation key exceeds 200 characters';
  end if;
  if p_lease_token is null then
    raise exception 'lease token is required';
  end if;

  v_operation_key := btrim(p_operation_key);
  select checkpoint.turn_message_id, checkpoint.chat_id
  into v_turn_message_id, v_chat_id
  from public.chat_action_checkpoints as checkpoint
  where checkpoint.workspace_id = p_workspace_id
    and checkpoint.operation_key = v_operation_key;
  if not found then
    raise exception 'action checkpoint does not exist';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'chat_action_turn:' || p_workspace_id || ':' || v_turn_message_id::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id || ':' || v_operation_key, 0)
  );
  select checkpoint.*
  into v_checkpoint
  from public.chat_action_checkpoints as checkpoint
  where checkpoint.workspace_id = p_workspace_id
    and checkpoint.operation_key = v_operation_key
  for update;

  if not found then
    raise exception 'action checkpoint does not exist';
  end if;
  if v_checkpoint.status <> 'running' then
    return query
    select
      checkpoint.id,
      checkpoint.workspace_id,
      checkpoint.chat_id,
      checkpoint.turn_message_id,
      checkpoint.operation_key,
      checkpoint.action_type,
      checkpoint.target_id,
      checkpoint.arguments,
      checkpoint.status,
      checkpoint.result,
      checkpoint.error_code
    from public.chat_action_checkpoints as checkpoint
    where checkpoint.id = v_checkpoint.id;
    return;
  end if;
  if exists (
    select 1
    from public.chat_action_turn_controls as control
    where control.workspace_id = p_workspace_id
      and control.chat_id = v_chat_id
      and control.turn_message_id = v_turn_message_id
  ) then
    update public.chat_action_checkpoints as checkpoint
    set status = 'cancelled',
        result = jsonb_build_object('ok', false, 'cancelled', true),
        error_code = 'turn_cancelled',
        lease_token = null,
        lease_expires_at = null,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where checkpoint.id = v_checkpoint.id
    returning checkpoint.* into v_checkpoint;
    return query
    select
      checkpoint.id,
      checkpoint.workspace_id,
      checkpoint.chat_id,
      checkpoint.turn_message_id,
      checkpoint.operation_key,
      checkpoint.action_type,
      checkpoint.target_id,
      checkpoint.arguments,
      checkpoint.status,
      checkpoint.result,
      checkpoint.error_code
    from public.chat_action_checkpoints as checkpoint
    where checkpoint.id = v_checkpoint.id;
    return;
  end if;
  if v_checkpoint.lease_token <> p_lease_token
    or v_checkpoint.lease_expires_at <= clock_timestamp() then
    raise exception 'action checkpoint lease is not owned by this worker';
  end if;

  select draft.*
  into v_draft
  from public.chat_artifacts as draft
  where draft.id = v_checkpoint.target_id
    and draft.workspace_id = p_workspace_id
  for update;

  if not found then
    v_terminal_status := 'failed';
    v_error_code := 'not_found';
    v_result := jsonb_build_object('ok', false, 'error', v_error_code);
  elsif v_draft.schedule_status in ('scheduled', 'publishing', 'published') then
    v_terminal_status := 'failed';
    v_error_code := 'locked';
    v_result := jsonb_build_object('ok', false, 'error', v_error_code);
  elsif v_draft.status not in ('idea', 'drafting', 'ready', 'posted') then
    v_terminal_status := 'failed';
    v_error_code := 'invalid_transition';
    v_result := jsonb_build_object('ok', false, 'error', v_error_code);
  elsif v_checkpoint.arguments->>'id' is distinct from v_checkpoint.target_id::text then
    raise exception 'checkpoint target and arguments do not match';
  elsif v_checkpoint.action_type = 'move_on_board' then
    v_move_status := v_checkpoint.arguments->>'status';
    if v_move_status not in ('idea', 'drafting', 'ready') then
      raise exception 'checkpoint move status is invalid';
    end if;
    v_already_satisfied := v_draft.status = v_move_status;
    if not v_already_satisfied then
      update public.chat_artifacts as draft
      set
        status = v_move_status,
        lifecycle_version = draft.lifecycle_version + 1
      where draft.id = v_draft.id
        and draft.workspace_id = p_workspace_id
      returning draft.* into v_draft;
    end if;
    v_result := jsonb_build_object(
      'ok', true,
      'draft', jsonb_build_object(
        'id', v_draft.id,
        'title', v_draft.title,
        'kind', v_draft.kind,
        'status', v_draft.status,
        'plan_to_post_on', v_draft.plan_to_post_on,
        'created_at', v_draft.created_at
      ),
      'already_satisfied', v_already_satisfied
    );
  elsif v_checkpoint.action_type = 'schedule_post' then
    if jsonb_typeof(v_checkpoint.arguments->'date') = 'null' then
      v_date := null;
    elsif jsonb_typeof(v_checkpoint.arguments->'date') = 'string' then
      v_date_text := v_checkpoint.arguments->>'date';
      if v_date_text !~ '^\d{4}-\d{2}-\d{2}$'
        or to_char(to_date(v_date_text, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> v_date_text then
        raise exception 'checkpoint planned date is invalid';
      end if;
      v_date := v_date_text::date;
    else
      raise exception 'checkpoint planned date is invalid';
    end if;
    if v_date is not null then
      v_timezone := coalesce(
        nullif(btrim(v_checkpoint.arguments->>'timezone'), ''),
        'UTC'
      );
      if not exists (
        select 1 from pg_timezone_names where name = v_timezone
      ) then
        raise exception 'checkpoint timezone is invalid';
      end if;
      v_local_today := (clock_timestamp() at time zone v_timezone)::date;
    end if;
    if v_date is not null and v_date < v_local_today then
      v_terminal_status := 'failed';
      v_error_code := 'date_elapsed';
      v_result := jsonb_build_object('ok', false, 'error', v_error_code);
    else
      v_already_satisfied := v_draft.plan_to_post_on is not distinct from v_date;
      if not v_already_satisfied then
        update public.chat_artifacts as draft
        set
          plan_to_post_on = v_date,
          lifecycle_version = draft.lifecycle_version + 1
        where draft.id = v_draft.id
          and draft.workspace_id = p_workspace_id
        returning draft.* into v_draft;
      end if;
      v_result := jsonb_build_object(
        'ok', true,
        'draft', jsonb_build_object(
          'id', v_draft.id,
          'title', v_draft.title,
          'kind', v_draft.kind,
          'status', v_draft.status,
          'plan_to_post_on', v_draft.plan_to_post_on,
          'created_at', v_draft.created_at
        ),
        'already_satisfied', v_already_satisfied
      );
    end if;
  else
    raise exception 'unsupported chat action type';
  end if;

  update public.chat_action_checkpoints as checkpoint
  set
    status = v_terminal_status,
    result = v_result,
    error_code = v_error_code,
    lease_token = null,
    lease_expires_at = null,
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where checkpoint.id = v_checkpoint.id
  returning checkpoint.* into v_checkpoint;

  return query
  select
    checkpoint.id,
    checkpoint.workspace_id,
    checkpoint.chat_id,
    checkpoint.turn_message_id,
    checkpoint.operation_key,
    checkpoint.action_type,
    checkpoint.target_id,
    checkpoint.arguments,
    checkpoint.status,
    checkpoint.result,
    checkpoint.error_code
  from public.chat_action_checkpoints as checkpoint
  where checkpoint.id = v_checkpoint.id;
end;
$$;

revoke all on table public.chat_action_checkpoints
  from public, anon, authenticated;
revoke all on table public.chat_action_retry_contexts
  from public, anon, authenticated;
revoke all on table public.chat_action_turn_controls
  from public, anon, authenticated;
revoke all on function public.save_chat_action_retry_context(
  text, uuid, uuid, uuid, text, jsonb, uuid[]
) from public, anon, authenticated;
revoke all on function public.claim_chat_action_checkpoint(
  text, uuid, uuid, text, text, uuid, jsonb, integer
) from public, anon, authenticated;
revoke all on function public.finish_chat_action_checkpoint(
  text, text, uuid, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.execute_chat_action_checkpoint(
  text, text, uuid
) from public, anon, authenticated;
revoke all on function public.cancel_chat_action_turn(
  text, uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.reset_uncommitted_chat_action_turn(
  text, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.release_chat_action_turn_leases(
  text, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.cancel_active_chat_action_turn(
  text, uuid, timestamptz, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.claim_chat_turn(
  text, uuid, text, uuid, integer, integer, integer, integer, numeric, numeric
) from public, anon, authenticated;

grant select, insert, update, delete on table public.chat_action_checkpoints
  to service_role;
grant select, insert, update, delete on table public.chat_action_retry_contexts
  to service_role;
grant select, insert, update, delete on table public.chat_action_turn_controls
  to service_role;
grant execute on function public.save_chat_action_retry_context(
  text, uuid, uuid, uuid, text, jsonb, uuid[]
) to service_role;
grant execute on function public.claim_chat_action_checkpoint(
  text, uuid, uuid, text, text, uuid, jsonb, integer
) to service_role;
grant execute on function public.finish_chat_action_checkpoint(
  text, text, uuid, text, jsonb, text
) to service_role;
grant execute on function public.execute_chat_action_checkpoint(
  text, text, uuid
) to service_role;
grant execute on function public.cancel_chat_action_turn(
  text, uuid, uuid, text
) to service_role;
grant execute on function public.reset_uncommitted_chat_action_turn(
  text, uuid, uuid
) to service_role;
grant execute on function public.release_chat_action_turn_leases(
  text, uuid, uuid
) to service_role;
grant execute on function public.cancel_active_chat_action_turn(
  text, uuid, timestamptz, text, uuid
) to service_role;
grant execute on function public.claim_chat_turn(
  text, uuid, text, uuid, integer, integer, integer, integer, numeric, numeric
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 95, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
