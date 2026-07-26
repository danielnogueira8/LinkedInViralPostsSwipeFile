-- Migration 137: make Workspace Learning snapshots immutable and replay-safe.
--
-- Replaying an identical calculation must return the stored snapshot without
-- rewriting its evidence or timestamps. A delayed calculation must never
-- supersede a newer snapshot. Only the persistence RPC may transition the
-- current slot to superseded, and only the purge RPC may delete history.

begin;

create or replace function public.protect_workspace_learning_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(
      current_setting('app.workspace_learning_operation', true),
      ''
    ) <> 'purge' then
      raise exception 'Workspace Learning snapshots are immutable'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if coalesce(
    current_setting('app.workspace_learning_operation', true),
    ''
  ) <> 'persist'
    or old.status not in ('active', 'shadow')
    or new.status <> 'superseded'
    or new.id is distinct from old.id
    or new.schema_version is distinct from old.schema_version
    or new.workspace_id is distinct from old.workspace_id
    or new.version is distinct from old.version
    or new.source_mode is distinct from old.source_mode
    or new.published_post_count is distinct from old.published_post_count
    or new.calculation_version is distinct from old.calculation_version
    or new.input_fingerprint is distinct from old.input_fingerprint
    or new.signals is distinct from old.signals
    or new.calculated_at is distinct from old.calculated_at
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Workspace Learning snapshots are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_learning_snapshots_immutable
  on public.workspace_learning_snapshots;
create trigger workspace_learning_snapshots_immutable
  before update or delete on public.workspace_learning_snapshots
  for each row execute function public.protect_workspace_learning_snapshot();

create or replace function public.persist_workspace_learning_snapshot(
  p_workspace_id text,
  p_status text,
  p_source_mode text,
  p_published_post_count integer,
  p_calculation_version text,
  p_input_fingerprint text,
  p_signals jsonb,
  p_calculated_at timestamptz
)
returns public.workspace_learning_snapshots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.workspace_learning_snapshots;
  current_snapshot public.workspace_learning_snapshots;
  inserted public.workspace_learning_snapshots;
  next_version integer;
begin
  if nullif(btrim(p_workspace_id), '') is null
    or p_status not in ('shadow', 'active')
    or p_source_mode not in ('voice_exemplars', 'published_posts')
    or p_published_post_count < 0
    or nullif(btrim(p_calculation_version), '') is null
    or nullif(btrim(p_input_fingerprint), '') is null
    or p_signals is null
    or jsonb_typeof(p_signals) <> 'array'
    or jsonb_array_length(p_signals) > 100
    or p_calculated_at is null
  then
    raise exception 'Valid Workspace Learning snapshot is required'
      using errcode = '22023';
  end if;
  if (
    p_published_post_count < 5
    and p_source_mode <> 'voice_exemplars'
  ) or (
    p_published_post_count >= 5
    and p_source_mode <> 'published_posts'
  ) then
    raise exception 'Workspace Learning source violates the cold-start boundary'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id, 0));

  select * into existing
  from public.workspace_learning_snapshots snapshot
  where snapshot.workspace_id = p_workspace_id
    and snapshot.status = p_status
    and snapshot.calculation_version = p_calculation_version
    and snapshot.input_fingerprint = p_input_fingerprint;
  if found then
    return existing;
  end if;

  select * into current_snapshot
  from public.workspace_learning_snapshots snapshot
  where snapshot.workspace_id = p_workspace_id
    and snapshot.status = p_status;
  if found and current_snapshot.calculated_at > p_calculated_at then
    return current_snapshot;
  end if;

  select coalesce(max(snapshot.version), 0) + 1 into next_version
  from public.workspace_learning_snapshots snapshot
  where snapshot.workspace_id = p_workspace_id;

  perform set_config('app.workspace_learning_operation', 'persist', true);
  update public.workspace_learning_snapshots snapshot
  set status = 'superseded'
  where snapshot.workspace_id = p_workspace_id
    and snapshot.status = p_status;

  insert into public.workspace_learning_snapshots (
    schema_version, workspace_id, version, status, source_mode,
    published_post_count, calculation_version, input_fingerprint,
    signals, calculated_at
  ) values (
    1, p_workspace_id, next_version, p_status, p_source_mode,
    p_published_post_count, p_calculation_version, p_input_fingerprint,
    p_signals, p_calculated_at
  )
  returning * into inserted;
  return inserted;
end;
$$;

create or replace function public.purge_workspace_learning(
  p_workspace_id text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer;
begin
  perform set_config('app.workspace_learning_operation', 'purge', true);
  delete from public.workspace_learning_snapshots snapshot
  where snapshot.workspace_id = p_workspace_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on table public.workspace_learning_snapshots
  from public, anon, authenticated, service_role;
grant select on table public.workspace_learning_snapshots to service_role;

revoke all on function public.protect_workspace_learning_snapshot()
  from public, anon, authenticated;

revoke all on function public.persist_workspace_learning_snapshot(
  text, text, text, integer, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.persist_workspace_learning_snapshot(
  text, text, text, integer, text, text, jsonb, timestamptz
) to service_role;

revoke all on function public.purge_workspace_learning(text)
  from public, anon, authenticated;
grant execute on function public.purge_workspace_learning(text)
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 137, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
