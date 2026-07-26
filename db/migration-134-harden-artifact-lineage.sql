-- Migration 134: make Artifact Lineage server-owned, collision-safe, and
-- purge-only.
--
-- Lineage is security-sensitive provenance. Browser-authenticated clients may
-- read their Workspace snapshot, but only the server may create one. Replays
-- must match the immutable canonical row exactly, and deletion is allowed only
-- through the explicit Workspace-erasure function.

begin;

drop policy if exists artifact_lineage_insert
  on public.artifact_lineage;

revoke insert, update, delete on table public.artifact_lineage
  from public, anon, authenticated;

create or replace function public.record_artifact_lineage(
  p_schema_version integer,
  p_workspace_id text,
  p_artifact_id uuid,
  p_parent_artifact_id uuid,
  p_cowork_command text,
  p_cowork_chat_id uuid,
  p_cowork_user_message_id uuid,
  p_user_direction text,
  p_inputs jsonb,
  p_origin jsonb,
  p_generation_model text,
  p_generated_at timestamptz,
  p_descriptor jsonb
)
returns public.artifact_lineage
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  persisted public.artifact_lineage%rowtype;
begin
  insert into public.artifact_lineage (
    schema_version,
    workspace_id,
    artifact_id,
    parent_artifact_id,
    cowork_command,
    cowork_chat_id,
    cowork_user_message_id,
    user_direction,
    inputs,
    origin,
    generation_model,
    generated_at,
    descriptor
  )
  values (
    p_schema_version,
    p_workspace_id,
    p_artifact_id,
    p_parent_artifact_id,
    p_cowork_command,
    p_cowork_chat_id,
    p_cowork_user_message_id,
    p_user_direction,
    p_inputs,
    p_origin,
    p_generation_model,
    p_generated_at,
    p_descriptor
  )
  on conflict (artifact_id) do nothing
  returning * into persisted;

  if not found then
    select *
    into persisted
    from public.artifact_lineage lineage
    where lineage.artifact_id = p_artifact_id;

    if not found
      or persisted.schema_version is distinct from p_schema_version
      or persisted.workspace_id is distinct from p_workspace_id
      or persisted.parent_artifact_id is distinct from p_parent_artifact_id
      or persisted.cowork_command is distinct from p_cowork_command
      or persisted.cowork_chat_id is distinct from p_cowork_chat_id
      or persisted.cowork_user_message_id
        is distinct from p_cowork_user_message_id
      or persisted.user_direction is distinct from p_user_direction
      or persisted.inputs is distinct from p_inputs
      or persisted.origin is distinct from p_origin
      or persisted.generation_model is distinct from p_generation_model
      or persisted.generated_at is distinct from p_generated_at
      or persisted.descriptor is distinct from p_descriptor
    then
      raise exception 'Artifact lineage collision'
        using errcode = '23505';
    end if;
  end if;

  return persisted;
end;
$$;

revoke all on function public.record_artifact_lineage(
  integer, text, uuid, uuid, text, uuid, uuid, text, jsonb, jsonb, text,
  timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_artifact_lineage(
  integer, text, uuid, uuid, text, uuid, uuid, text, jsonb, jsonb, text,
  timestamptz, jsonb
) to service_role;

create or replace function public.reject_artifact_lineage_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  lineage_owner text;
begin
  select pg_get_userbyid(class.relowner)
  into lineage_owner
  from pg_class class
  join pg_namespace namespace on namespace.oid = class.relnamespace
  where namespace.nspname = 'public'
    and class.relname = 'artifact_lineage';

  if current_user = lineage_owner
    and current_setting(
      'app.artifact_lineage_purge_workspace',
      true
    ) = old.workspace_id
  then
    return old;
  end if;

  raise exception 'Artifact lineage is append-only'
    using errcode = '55000';
end;
$$;

create or replace function public.purge_artifact_lineage(
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
  if p_workspace_id is null or length(btrim(p_workspace_id)) = 0 then
    raise exception 'Workspace id is required'
      using errcode = '22023';
  end if;

  perform set_config(
    'app.artifact_lineage_purge_workspace',
    p_workspace_id,
    true
  );

  delete from public.artifact_lineage
  where workspace_id = p_workspace_id;
  get diagnostics deleted_count = row_count;

  perform set_config(
    'app.artifact_lineage_purge_workspace',
    '',
    true
  );
  return deleted_count;
exception when others then
  perform set_config(
    'app.artifact_lineage_purge_workspace',
    '',
    true
  );
  raise;
end;
$$;

revoke all on function public.purge_artifact_lineage(text)
  from public, anon, authenticated;
grant execute on function public.purge_artifact_lineage(text)
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 134, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
