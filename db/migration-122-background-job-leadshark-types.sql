-- Migration 122: add LeadShark job types to background_jobs.
--
-- A CHECK constraint can't be ALTERed — it must be dropped and recreated with
-- the FULL value list. We re-list every EXISTING value verbatim (the live set
-- established by migration 115, which removed the retired 'weekly_batch') and
-- append the two new LeadShark job types. These must stay in lockstep with
-- BACKGROUND_JOB_TYPES in lib/background-jobs.ts (updated in the same change) —
-- the app-layer type is enforced at enqueue time.

begin;

alter table public.background_jobs
  drop constraint if exists background_jobs_type_check;

alter table public.background_jobs
  add constraint background_jobs_type_check
  check (type in (
    -- Existing (verbatim from migration 115 — the current live constraint):
    'lead_magnet_resource',
    'lead_magnet_image',
    'creator_style_generation',
    'voice_generation',
    'scrape',
    -- New (LeadShark):
    'leadshark_bind_automation',
    'leadshark_sync_stats'
  ));

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 122, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
