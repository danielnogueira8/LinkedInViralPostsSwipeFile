-- Move turn state out of synthetic transcript tool_calls markers and into real
-- chat_messages columns. This is Phase 3 of the Cowork unification refactor.
--
-- Backfill is best-effort: malformed tool_calls are skipped, and rows that
-- already have a real column value are left untouched.

alter table public.chat_messages
  add column if not exists model_source_id text,
  add column if not exists applied_skills jsonb,
  add column if not exists no_model_format_id text,
  add column if not exists creator_style_context jsonb,
  add column if not exists lead_magnet_id uuid,
  add column if not exists composer_starter_id text,
  add column if not exists generation_config jsonb,
  add column if not exists recoverable_error jsonb,
  add column if not exists turn_usage jsonb;

-- Backfill model_source_id from the synthetic _model_source_attached marker.
update public.chat_messages
set model_source_id = (
  select (elem -> 'function' ->> 'arguments')::jsonb ->> 'id'
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_model_source_attached'
  limit 1
)
where model_source_id is null
  and role = 'user'
  and tool_calls is not null;

-- Backfill applied_skills from the synthetic _skills_applied marker.
update public.chat_messages
set applied_skills = (
  select (elem -> 'function' ->> 'arguments')::jsonb
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_skills_applied'
  limit 1
)
where applied_skills is null
  and role = 'user'
  and tool_calls is not null;

-- Backfill no_model_format_id from the synthetic _post_format_selected marker.
update public.chat_messages
set no_model_format_id = (
  select (elem -> 'function' ->> 'arguments')::jsonb ->> 'id'
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_post_format_selected'
  limit 1
)
where no_model_format_id is null
  and role = 'user'
  and tool_calls is not null;

-- Backfill creator_style_context from the synthetic _creator_style_selected marker.
update public.chat_messages
set creator_style_context = (
  select (elem -> 'function' ->> 'arguments')::jsonb
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_creator_style_selected'
  limit 1
)
where creator_style_context is null
  and role = 'user'
  and tool_calls is not null;

-- Backfill lead_magnet_id from the synthetic _lead_magnet_selected marker.
update public.chat_messages
set lead_magnet_id = (
  select (elem -> 'function' ->> 'arguments')::jsonb ->> 'id'
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_lead_magnet_selected'
  limit 1
)::uuid
where lead_magnet_id is null
  and role = 'user'
  and tool_calls is not null;

-- Backfill composer_starter_id from the synthetic _composer_starter_selected marker.
update public.chat_messages
set composer_starter_id = (
  select (elem -> 'function' ->> 'arguments')::jsonb ->> 'starterId'
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_composer_starter_selected'
  limit 1
)
where composer_starter_id is null
  and role = 'user'
  and tool_calls is not null;

-- Backfill generation_config from the synthetic _generation_config_selected marker.
update public.chat_messages
set generation_config = (
  select (elem -> 'function' ->> 'arguments')::jsonb
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_generation_config_selected'
  limit 1
)
where generation_config is null
  and role = 'user'
  and tool_calls is not null;

-- Backfill recoverable_error from the synthetic _recoverable marker on assistant rows.
update public.chat_messages
set recoverable_error = (
  select (elem -> 'function' ->> 'arguments')::jsonb
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_recoverable'
  limit 1
)
where recoverable_error is null
  and role = 'assistant'
  and tool_calls is not null;

-- Backfill turn_usage from the synthetic _turn_usage marker on assistant rows.
update public.chat_messages
set turn_usage = (
  select (elem -> 'function' ->> 'arguments')::jsonb
  from jsonb_array_elements(tool_calls) as elem
  where elem ->> 'id' = '_turn_usage'
  limit 1
)
where turn_usage is null
  and role = 'assistant'
  and tool_calls is not null;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 112, now())
on conflict (singleton)
do update set version = 112, updated_at = now();
