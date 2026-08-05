-- Migration 176: per-invocation cron run history.
--
-- Vercel Cron keeps only per-invocation logs, and postCronAlert() fires on a
-- THROWN failure. Neither answers the questions that actually come up:
--   "did this run today, and how long did it take?"
--   "why did we spend $0.70 on a day nobody used the app?"
--   "did the scrape enqueue succeed for all four actors, or three?"
--
-- Answering the cost question took reconstructing intent from usage_events —
-- a ledger of MODEL CALLS, which only sees crons that happen to spend money.
-- A cron that silently does nothing leaves no trace there at all, which is the
-- most expensive failure mode for a content pipeline: it looks fine.
--
-- One row per invocation. `counts` is free-form jsonb rather than typed
-- columns because every cron reports something different (workspaces swept,
-- posts scraped, drafts published) and a shared shape would either be mostly
-- null or force a migration per cron.
--
-- Deliberately NOT workspace-scoped: crons run across all workspaces, so this
-- is platform telemetry. It is service-role only, never exposed to a browser.

begin;

create table if not exists public.cron_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  status text not null check (status in ('ok', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  counts jsonb not null default '{}'::jsonb,
  error text
);

-- The two read patterns: "recent runs of one job" and "everything recently".
create index if not exists cron_runs_job_started_idx
  on public.cron_runs (job, started_at desc);
create index if not exists cron_runs_started_idx
  on public.cron_runs (started_at desc);

alter table public.cron_runs enable row level security;
-- No policy: RLS on with zero policies denies every non-service-role read,
-- which is the intent. Service role bypasses RLS.
revoke all on table public.cron_runs from public, anon, authenticated;
grant all on table public.cron_runs to service_role;

-- Keep the table bounded. History older than 30 days has no diagnostic value
-- and this table gets a row per cron per invocation — the every-minute jobs
-- queue would otherwise dominate it within weeks.
create or replace function public.prune_cron_runs(p_before timestamptz)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from public.cron_runs where started_at < p_before;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_cron_runs(timestamptz)
  from public, anon, authenticated;
grant execute on function public.prune_cron_runs(timestamptz) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 176, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
