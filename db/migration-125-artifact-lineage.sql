-- Migration 125: immutable Artifact lineage for the content-learning loop.
--
-- One row records how an Artifact was created. Later lifecycle records link to
-- this row instead of rewriting it. Browser-authenticated clients may select
-- and insert only inside their Workspace; no update/delete policy is granted.
-- Service-role deletion is rejected while the Artifact exists. The only
-- permitted deletion is the explicit Workspace-erasure path after its Artifact
-- has already been removed.

begin;

create table if not exists public.artifact_lineage (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null default 1 check (schema_version = 1),
  workspace_id text not null,
  -- Provenance identifiers are immutable snapshots, not cascading lifecycle
  -- references. The insert trigger below validates their Workspace ownership.
  artifact_id uuid not null unique,
  parent_artifact_id uuid,
  cowork_command text not null check (cowork_command in ('ask','create','edit')),
  cowork_chat_id uuid,
  cowork_user_message_id uuid,
  user_direction text not null check (length(btrim(user_direction)) > 0),
  inputs jsonb not null check (jsonb_typeof(inputs) = 'object'),
  origin jsonb not null check (jsonb_typeof(origin) = 'object'),
  generation_model text not null check (length(btrim(generation_model)) > 0),
  generated_at timestamptz not null,
  descriptor jsonb not null check (jsonb_typeof(descriptor) = 'object'),
  created_at timestamptz not null default now(),
  check (
    coalesce(origin->>'kind', '') <> 'cowork'
    or (cowork_chat_id is not null and cowork_user_message_id is not null)
  )
);

create or replace function public.validate_artifact_lineage_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.chat_artifacts artifact
    where artifact.id = new.artifact_id
      and artifact.workspace_id = new.workspace_id
  ) then
    raise exception 'Artifact lineage Artifact is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.parent_artifact_id is not null and not exists (
    select 1
    from public.chat_artifacts parent
    where parent.id = new.parent_artifact_id
      and parent.workspace_id = new.workspace_id
  ) then
    raise exception 'Artifact lineage parent is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.cowork_chat_id is not null and not exists (
    select 1
    from public.chats chat
    where chat.id = new.cowork_chat_id
      and chat.workspace_id = new.workspace_id
  ) then
    raise exception 'Artifact lineage chat is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.cowork_user_message_id is not null and not exists (
    select 1
    from public.chat_messages message
    where message.id = new.cowork_user_message_id
      and message.workspace_id = new.workspace_id
      and message.chat_id = new.cowork_chat_id
      and message.role = 'user'
  ) then
    raise exception 'Artifact lineage message is outside the Workspace or chat'
      using errcode = '23503';
  end if;

  if new.inputs->>'contentTemplateId' is not null
    and new.inputs->>'contentTemplateId' not like 'builtin:%'
    and not exists (
      select 1 from public.content_templates template
      where template.id::text = new.inputs->>'contentTemplateId'
        and template.workspace_id = new.workspace_id
    )
  then
    raise exception 'Artifact lineage template is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.inputs->>'modelSourceId' is not null and not exists (
    select 1 from public.chat_modeling_sources model_source
    where model_source.id::text = new.inputs->>'modelSourceId'
      and model_source.workspace_id = new.workspace_id
  ) then
    raise exception 'Artifact lineage Model Source is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.inputs->>'creatorStyleId' is not null and not exists (
    select 1 from public.creator_style_profiles style
    where style.id::text = new.inputs->>'creatorStyleId'
      and style.workspace_id = new.workspace_id
  ) then
    raise exception 'Artifact lineage creator style is outside the Workspace'
      using errcode = '23503';
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(
      coalesce(new.inputs->'customSkillIds', '[]'::jsonb)
    ) skill_id
    where skill_id.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and not exists (
        select 1 from public.custom_skills skill
        where skill.id::text = skill_id.value
          and skill.workspace_id = new.workspace_id
      )
  ) then
    raise exception 'Artifact lineage custom skill is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.inputs->>'leadMagnetId' is not null and not exists (
    select 1 from public.lead_magnets lead_magnet
    where lead_magnet.id::text = new.inputs->>'leadMagnetId'
      and lead_magnet.workspace_id = new.workspace_id
  ) then
    raise exception 'Artifact lineage lead magnet is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.origin->>'weekPlanItemId' is not null and not exists (
    select 1 from public.agent_week_plan_items week_item
    where week_item.id::text = new.origin->>'weekPlanItemId'
      and week_item.workspace_id = new.workspace_id
  ) then
    raise exception 'Artifact lineage week-plan item is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.origin->>'opportunityId' is not null and not exists (
    select 1 from public.agent_opportunities opportunity
    where opportunity.id::text = new.origin->>'opportunityId'
      and opportunity.workspace_id = new.workspace_id
  ) then
    raise exception 'Artifact lineage opportunity is outside the Workspace'
      using errcode = '23503';
  end if;

  return new;
end;
$$;

drop trigger if exists artifact_lineage_validate_scope
  on public.artifact_lineage;
create trigger artifact_lineage_validate_scope
  before insert on public.artifact_lineage
  for each row execute function public.validate_artifact_lineage_scope();

create or replace function public.reject_artifact_lineage_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Artifact lineage is immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists artifact_lineage_reject_update
  on public.artifact_lineage;
create trigger artifact_lineage_reject_update
  before update on public.artifact_lineage
  for each row execute function public.reject_artifact_lineage_update();

create or replace function public.reject_artifact_lineage_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.chat_artifacts artifact
    where artifact.id = old.artifact_id
  ) then
    raise exception 'Artifact lineage is append-only'
      using errcode = '55000';
  end if;

  -- GDPR/Workspace erasure deletes the owning Artifact first, then this
  -- immutable snapshot. Normal application lifecycle cannot remove it.
  return old;
end;
$$;

drop trigger if exists artifact_lineage_reject_delete
  on public.artifact_lineage;
create trigger artifact_lineage_reject_delete
  before delete on public.artifact_lineage
  for each row execute function public.reject_artifact_lineage_delete();

create index if not exists artifact_lineage_workspace_created_idx
  on public.artifact_lineage (workspace_id, created_at desc);

create index if not exists artifact_lineage_parent_idx
  on public.artifact_lineage (workspace_id, parent_artifact_id)
  where parent_artifact_id is not null;

alter table public.artifact_lineage enable row level security;

drop policy if exists artifact_lineage_select on public.artifact_lineage;
create policy artifact_lineage_select on public.artifact_lineage
  for select
  using (workspace_id = auth_workspace_id());

drop policy if exists artifact_lineage_insert on public.artifact_lineage;
create policy artifact_lineage_insert on public.artifact_lineage
  for insert
  with check (workspace_id = auth_workspace_id());

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 125, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
