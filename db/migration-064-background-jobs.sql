-- Migration 064: Background jobs and provider locks
--
-- Lightweight Supabase-backed queue for heavy async work. Feature-specific
-- status tables (batch_runs, voice_profiles, creator_style_profiles, runs,
-- chat_artifacts metadata) remain the user-facing progress surfaces; this table
-- is the durable execution layer underneath them.

create table if not exists background_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  type text not null check (
    type in (
      'weekly_batch',
      'lead_magnet_resource',
      'lead_magnet_image',
      'creator_style_generation',
      'voice_generation',
      'scrape'
    )
  ),
  status text not null default 'queued' check (
    status in ('queued', 'running', 'done', 'failed', 'cancelled')
  ),
  payload jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists background_jobs_claim_idx
  on background_jobs(status, run_after, created_at)
  where status = 'queued';

create index if not exists background_jobs_workspace_idx
  on background_jobs(workspace_id, created_at desc);

create index if not exists background_jobs_health_idx
  on background_jobs(type, status, created_at desc);

alter table background_jobs enable row level security;
drop policy if exists background_jobs_isolation on background_jobs;
create policy background_jobs_isolation on background_jobs
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

create table if not exists provider_locks (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  work_type text not null,
  job_id uuid not null references background_jobs(id) on delete cascade,
  workspace_id text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique(provider, work_type, job_id)
);

create index if not exists provider_locks_scope_idx
  on provider_locks(provider, work_type, expires_at);

create index if not exists provider_locks_job_idx
  on provider_locks(job_id);

alter table provider_locks enable row level security;
drop policy if exists provider_locks_isolation on provider_locks;
create policy provider_locks_isolation on provider_locks
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

-- Atomic queue claim. A cron worker may run concurrently, so this uses
-- FOR UPDATE SKIP LOCKED to ensure each due job is claimed once.
create or replace function claim_background_job(
  p_worker_id text,
  p_stale_after_secs int default 900
)
returns setof background_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update background_jobs
  set
    status = 'queued',
    locked_at = null,
    locked_by = null,
    updated_at = now(),
    run_after = now(),
    error = coalesce(error, 'Recovered after worker timeout.')
  where status = 'running'
    and locked_at < now() - make_interval(secs => p_stale_after_secs)
    and attempts < max_attempts;

  update background_jobs
  set
    status = 'failed',
    locked_at = null,
    locked_by = null,
    finished_at = coalesce(finished_at, now()),
    updated_at = now(),
    error = coalesce(error, 'Job timed out after maximum attempts.')
  where status = 'running'
    and locked_at < now() - make_interval(secs => p_stale_after_secs)
    and attempts >= max_attempts;

  return query
  with candidate as (
    select id
    from background_jobs
    where status = 'queued'
      and run_after <= now()
      and attempts < max_attempts
    order by run_after asc, created_at asc
    limit 1
    for update skip locked
  )
  update background_jobs j
  set
    status = 'running',
    locked_at = now(),
    locked_by = p_worker_id,
    started_at = coalesce(j.started_at, now()),
    attempts = j.attempts + 1,
    updated_at = now(),
    error = null
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

-- Atomic provider/work-type lock. The advisory transaction lock serializes the
-- count+insert section per provider/work_type so global caps are respected even
-- when several cron workers overlap.
create or replace function acquire_provider_lock(
  p_provider text,
  p_work_type text,
  p_job_id uuid,
  p_workspace_id text,
  p_limit int,
  p_ttl_secs int default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active int;
begin
  if p_limit <= 0 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_provider || ':' || p_work_type));

  delete from provider_locks
  where expires_at <= now();

  select count(*)
  into v_active
  from provider_locks
  where provider = p_provider
    and work_type = p_work_type
    and expires_at > now();

  if v_active >= p_limit then
    return false;
  end if;

  insert into provider_locks (
    provider,
    work_type,
    job_id,
    workspace_id,
    expires_at
  )
  values (
    p_provider,
    p_work_type,
    p_job_id,
    p_workspace_id,
    now() + make_interval(secs => p_ttl_secs)
  )
  on conflict (provider, work_type, job_id)
  do update set
    acquired_at = now(),
    expires_at = excluded.expires_at;

  return true;
end;
$$;

create or replace function release_provider_lock(p_job_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from provider_locks where job_id = p_job_id;
$$;
