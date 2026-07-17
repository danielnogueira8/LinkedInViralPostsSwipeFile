-- Add an optional `detail` field to content_preferences: a longer, freer-form
-- supporting note stored alongside the short, always-injected `rule` one-liner.
-- Lets the user (or the agent via remember_preference) capture real context —
-- "why", numbers, dates, caveats — without squeezing it into the 160-char rule
-- or silently losing it to truncation. No length cap at the DB level, matching
-- `rule`'s own text column; bounded at the app layer (PREF_DETAIL_MAX).

begin;

alter table public.content_preferences
  add column if not exists detail text;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 104, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
