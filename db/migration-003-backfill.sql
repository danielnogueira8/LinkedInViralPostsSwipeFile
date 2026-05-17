-- Persist backfill state so any tab can show its progress
create table if not exists backfill_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  total int not null default 0,
  templated int not null default 0,
  classified int not null default 0,
  errors int not null default 0,
  current_index int,
  current_name text,
  current_kind text,
  error text
);
create index if not exists backfill_runs_started_idx on backfill_runs(started_at desc);
