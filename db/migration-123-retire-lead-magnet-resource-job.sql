-- Migration 123: retire the never-implemented lead_magnet_resource job type.
--
-- No producer enqueues this type and the worker has never had a payload contract
-- or handler for it. Preserve terminal history, but cancel any stranded work and
-- prevent the database from accepting new queued/running jobs of this type.

begin;

delete from public.provider_locks
where job_id in (
  select id
  from public.background_jobs
  where type = 'lead_magnet_resource'
    and status in ('queued', 'running')
);

update public.background_jobs
set status = 'cancelled',
    error = 'Retired unsupported background job type: lead_magnet_resource.',
    locked_at = null,
    locked_by = null,
    finished_at = coalesce(finished_at, now()),
    updated_at = now()
where type = 'lead_magnet_resource'
  and status in ('queued', 'running');

alter table public.background_jobs
  drop constraint if exists background_jobs_type_check;

alter table public.background_jobs
  add constraint background_jobs_type_check
  check (
    type in (
      'lead_magnet_image',
      'creator_style_generation',
      'voice_generation',
      'scrape',
      'leadshark_bind_automation',
      'leadshark_sync_stats'
    )
    or (
      type = 'lead_magnet_resource'
      and status in ('done', 'failed', 'cancelled')
    )
  );

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 123, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
