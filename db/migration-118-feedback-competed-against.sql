-- Migration 118: record which draft won a two-draft comparison.
--
-- Phase B (two-draft presentation) emits one modeled draft + one grounded-original
-- draft per request. When the user rates either card, we persist the sibling
-- artifact id it competed against so the structure matcher can later learn
-- whether modeled or grounded-original drafts win more often.

begin;

alter table public.content_feedback
  add column if not exists competed_against text;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 118, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
