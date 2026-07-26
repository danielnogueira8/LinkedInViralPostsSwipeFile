-- Migration 126: idempotently backfill lineage coverage for historical Drafts.
--
-- Older rows predate generation-lineage seeds, so their exact direction and
-- inputs cannot be reconstructed safely. Record that uncertainty explicitly
-- rather than guessing from a later chat message or mutable metadata.

begin;

alter table public.artifact_lineage
  drop constraint if exists artifact_lineage_cowork_command_check;
alter table public.artifact_lineage
  add constraint artifact_lineage_cowork_command_check
  check (cowork_command in ('ask','create','edit','unknown'));

-- Historical JSON can contain malformed values from older application
-- versions. Keep timestamp parsing fail-closed so one bad seed cannot abort
-- the entire migration.
create or replace function pg_temp.try_parse_lineage_timestamp(value text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  return value::timestamptz;
exception when others then
  return null;
end;
$$;

-- Exact replay for generated Drafts written while the lineage table was
-- unavailable (for example, code deployed before this migration was applied).
-- The seed is accepted only when the same source Artifact exists in the
-- server-persisted transcript and points at the exact user message.
insert into public.artifact_lineage (
  schema_version, workspace_id, artifact_id, parent_artifact_id,
  cowork_command, cowork_chat_id, cowork_user_message_id, user_direction,
  inputs, origin, generation_model, generated_at, descriptor
)
select
  1,
  artifact.workspace_id,
  artifact.id,
  case
    when seed->>'parentArtifactId' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and exists (
        select 1 from public.chat_artifacts parent
        where parent.id::text = seed->>'parentArtifactId'
          and parent.workspace_id = artifact.workspace_id
      )
    then (seed->>'parentArtifactId')::uuid
    else null
  end,
  case seed->>'coworkCommand'
    when 'edit' then 'edit'
    else 'create'
  end,
  artifact.chat_id,
  user_message.id,
  user_message.content,
  jsonb_build_object(
    'modelSourceId', seed->'modelSourceId',
    'contentTemplateId', seed->'contentTemplateId',
    'creatorStyleId', seed->'creatorStyleId',
    'customSkillIds',
      case
        when jsonb_typeof(seed->'customSkillIds') = 'array'
          then seed->'customSkillIds'
        else '[]'::jsonb
      end,
    'leadMagnetId', seed->'leadMagnetId',
    'voiceProfileRevision', seed->'voiceProfileRevision'
  ),
  jsonb_build_object(
    'kind',
      case
        when week_item.id is not null
          then 'week_plan'
        when opportunity.id is not null
          then 'agent_opportunity'
        else 'cowork'
      end,
    'weekPlanItemId',
      to_jsonb(week_item.id),
    'opportunityId',
      to_jsonb(opportunity.id)
  ),
  seed->>'generationModel',
  parsed_seed.generated_at,
  jsonb_build_object(
    'topic', nullif(left(btrim(coalesce(artifact.title, '')), 240), ''),
    'hookType', null,
    'structure', null,
    'ctaType', null
  )
from public.chat_artifacts artifact
cross join lateral (
  select artifact.meta->'content_lineage' as submitted_seed
) lineage_seed
join public.chat_messages user_message
  on user_message.id::text = submitted_seed->>'userMessageId'
  and user_message.chat_id = artifact.chat_id
  and user_message.workspace_id = artifact.workspace_id
  and user_message.role = 'user'
cross join lateral (
  select source_artifact.value->'meta'->'content_lineage' as seed
  from public.chat_messages assistant_message
  cross join lateral
    jsonb_array_elements(
      case
        when jsonb_typeof(assistant_message.artifacts) = 'array'
          then assistant_message.artifacts
        else '[]'::jsonb
      end
    )
    source_artifact(value)
  where assistant_message.chat_id = artifact.chat_id
    and assistant_message.workspace_id = artifact.workspace_id
    and assistant_message.role = 'assistant'
    and source_artifact.value->>'id' = submitted_seed->>'sourceArtifactId'
    and source_artifact.value->'meta'->'content_lineage'->>'userMessageId'
      = user_message.id::text
  order by assistant_message.created_at desc
  limit 1
) server_lineage_seed
cross join lateral (
  select pg_temp.try_parse_lineage_timestamp(
    seed->>'generatedAt'
  ) as generated_at
) parsed_seed
left join lateral (
  select item.id
  from public.agent_week_plan_items item
  where item.drafted_artifact_id = artifact.id
    and item.workspace_id = artifact.workspace_id
  order by item.created_at desc
  limit 1
) week_item on true
left join lateral (
  select candidate.id
  from public.agent_opportunities candidate
  where candidate.drafted_artifact_id = artifact.id
    and candidate.workspace_id = artifact.workspace_id
  order by candidate.created_at desc
  limit 1
) opportunity on true
where jsonb_typeof(seed) = 'object'
  and seed ?& array[
    'schemaVersion',
    'sourceArtifactId',
    'userMessageId',
    'coworkCommand',
    'parentArtifactId',
    'modelSourceId',
    'contentTemplateId',
    'creatorStyleId',
    'customSkillIds',
    'leadMagnetId',
    'voiceProfileRevision',
    'generationModel',
    'generatedAt'
  ]
  and not exists (
    select 1
    from jsonb_object_keys(seed) seed_key
    where seed_key not in (
      'schemaVersion',
      'sourceArtifactId',
      'userMessageId',
      'coworkCommand',
      'parentArtifactId',
      'modelSourceId',
      'contentTemplateId',
      'creatorStyleId',
      'customSkillIds',
      'leadMagnetId',
      'voiceProfileRevision',
      'generationModel',
      'generatedAt'
    )
  )
  and seed->'schemaVersion' = '1'::jsonb
  and jsonb_typeof(seed->'sourceArtifactId') = 'string'
  and length(btrim(seed->>'sourceArtifactId')) between 1 and 200
  and jsonb_typeof(seed->'userMessageId') = 'string'
  and seed->>'userMessageId' = user_message.id::text
  and jsonb_typeof(seed->'coworkCommand') = 'string'
  and jsonb_typeof(seed->'generationModel') = 'string'
  and length(btrim(seed->>'generationModel')) between 1 and 200
  and jsonb_typeof(seed->'generatedAt') = 'string'
  and seed->>'generatedAt' ~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  and seed->>'coworkCommand' in ('create', 'edit')
  and parsed_seed.generated_at is not null
  and length(btrim(user_message.content)) between 1 and 12000
  and (
    jsonb_typeof(seed->'parentArtifactId') = 'null'
    or (
      jsonb_typeof(seed->'parentArtifactId') = 'string'
      and length(btrim(seed->>'parentArtifactId')) between 1 and 160
    )
  )
  and (
    jsonb_typeof(seed->'modelSourceId') = 'null'
    or (
      jsonb_typeof(seed->'modelSourceId') = 'string'
      and length(btrim(seed->>'modelSourceId')) between 1 and 160
    )
  )
  and (
    jsonb_typeof(seed->'contentTemplateId') = 'null'
    or (
      jsonb_typeof(seed->'contentTemplateId') = 'string'
      and length(btrim(seed->>'contentTemplateId')) between 1 and 160
    )
  )
  and (
    jsonb_typeof(seed->'creatorStyleId') = 'null'
    or (
      jsonb_typeof(seed->'creatorStyleId') = 'string'
      and length(btrim(seed->>'creatorStyleId')) between 1 and 160
    )
  )
  and (
    jsonb_typeof(seed->'customSkillIds') = 'array'
    and jsonb_array_length(seed->'customSkillIds') <= 20
    and not exists (
      select 1
      from jsonb_array_elements(seed->'customSkillIds') skill_value
      where jsonb_typeof(skill_value.value) <> 'string'
        or length(btrim(skill_value.value #>> '{}')) not between 1 and 160
    )
  )
  and (
    jsonb_typeof(seed->'leadMagnetId') = 'null'
    or (
      jsonb_typeof(seed->'leadMagnetId') = 'string'
      and length(btrim(seed->>'leadMagnetId')) between 1 and 160
    )
  )
  and (
    jsonb_typeof(seed->'voiceProfileRevision') = 'null'
    or (
      jsonb_typeof(seed->'voiceProfileRevision') = 'string'
      and length(btrim(seed->>'voiceProfileRevision')) between 1 and 160
    )
  )
  and (
    seed->>'modelSourceId' is null
    or exists (
      select 1 from public.chat_modeling_sources model_source
      where model_source.id::text = seed->>'modelSourceId'
        and model_source.workspace_id = artifact.workspace_id
    )
  )
  and (
    seed->>'contentTemplateId' is null
    or seed->>'contentTemplateId' like 'builtin:%'
    or exists (
      select 1 from public.content_templates template
      where template.id::text = seed->>'contentTemplateId'
        and template.workspace_id = artifact.workspace_id
    )
  )
  and (
    seed->>'creatorStyleId' is null
    or exists (
      select 1 from public.creator_style_profiles style
      where style.id::text = seed->>'creatorStyleId'
        and style.workspace_id = artifact.workspace_id
    )
  )
  and (
    seed->>'leadMagnetId' is null
    or exists (
      select 1 from public.lead_magnets lead_magnet
      where lead_magnet.id::text = seed->>'leadMagnetId'
        and lead_magnet.workspace_id = artifact.workspace_id
    )
  )
  and not exists (
    select 1
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(seed->'customSkillIds') = 'array'
          then seed->'customSkillIds'
        else '[]'::jsonb
      end
    ) skill_id
    where skill_id.value ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and not exists (
        select 1 from public.custom_skills skill
        where skill.id::text = skill_id.value
          and skill.workspace_id = artifact.workspace_id
      )
  )
on conflict (artifact_id) do nothing;

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
select
  1,
  artifact.workspace_id,
  artifact.id,
  null,
  'unknown',
  null,
  null,
  'Historical direction unavailable; Draft predates lineage capture.',
  jsonb_build_object(
    'modelSourceId', null,
    'contentTemplateId', null,
    'creatorStyleId', null,
    'customSkillIds', '[]'::jsonb,
    'leadMagnetId', null,
    'voiceProfileRevision', null
  ),
  jsonb_build_object(
    'kind', 'backfill',
    'weekPlanItemId', null,
    'opportunityId', null
  ),
  'unknown',
  artifact.created_at,
  jsonb_build_object(
    'topic', nullif(left(btrim(coalesce(artifact.title, '')), 240), ''),
    'hookType', null,
    'structure', null,
    'ctaType', null
  )
from public.chat_artifacts artifact
where not exists (
  select 1
  from public.artifact_lineage lineage
  where lineage.artifact_id = artifact.id
)
on conflict (artifact_id) do nothing;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 126, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
