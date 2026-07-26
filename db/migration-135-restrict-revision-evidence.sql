-- Migration 135: keep raw draft revision bodies server-only.
--
-- Voice can still explain learned preferences through the bounded,
-- service-only list_content_preference_evidence RPC. Browser roles must never
-- select the durable before_body / after_body source material directly.

begin;

drop policy if exists draft_edit_events_isolation
  on public.draft_edit_events;
drop policy if exists draft_edit_events_select
  on public.draft_edit_events;

revoke select on table public.draft_edit_events
  from public, anon, authenticated;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 135, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
