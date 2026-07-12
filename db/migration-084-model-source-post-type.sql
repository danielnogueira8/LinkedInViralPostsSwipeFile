-- Carry the authoritative source classification through "Model with Cowork".
-- Existing transient rows remain null and use text classification as a legacy
-- fallback until the daily cleanup removes them.

alter table chat_modeling_sources
  add column if not exists post_type text;

alter table chat_modeling_sources
  drop constraint if exists chat_modeling_sources_post_type_check;

alter table chat_modeling_sources
  add constraint chat_modeling_sources_post_type_check
  check (post_type is null or post_type in ('regular', 'lead_magnet'));
