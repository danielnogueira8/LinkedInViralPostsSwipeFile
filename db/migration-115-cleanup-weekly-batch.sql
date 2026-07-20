-- Migration 115: clean up weekly-batch remnants.
--
-- The weekly-batch feature was removed in the preceding code change. This
-- migration drops its dedicated progress/slot tables and deletes any leftover
-- weekly_batch background-job rows so the worker never tries to process an
-- unsupported job type.
--
-- chat_artifacts rows that were created with status 'pending_review' or
-- 'rejected' by the old weekly batch are intentionally left untouched; removing
-- those statuses from the check constraint would require migrating or deleting
-- existing rows, and the app simply no longer creates them.

begin;

-- 1. Drop the weekly-batch live-progress tables.
drop table if exists public.batch_draft_slots cascade;
drop table if exists public.batch_runs cascade;

-- 2. Delete any queued/running weekly_batch background jobs.
delete from public.background_jobs
where type = 'weekly_batch';

-- 3. Remove weekly_batch from the background_jobs type check if it exists.
--    The remaining supported types are defined in lib/background-jobs.ts.
alter table public.background_jobs
  drop constraint if exists background_jobs_type_check;

alter table public.background_jobs
  add constraint background_jobs_type_check
  check (type in (
    'lead_magnet_resource',
    'lead_magnet_image',
    'creator_style_generation',
    'voice_generation',
    'scrape'
  ));

-- 4. Bump schema version.
insert into public.app_schema_version (singleton, version, updated_at)
values (true, 115, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
