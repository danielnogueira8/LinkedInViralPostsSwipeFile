-- Migration 109: persist structured attachment blocks on the user message row.
--
-- Attachment text was previously consumed by the current turn only; follow-up
-- turns could not see it. This column stores the assembled content_blocks so
-- later history loads can re-inject them into the model transcript without
-- polluting the human-readable `content` column.

begin;

alter table public.chat_messages
  add column if not exists content_blocks jsonb;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 109, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
