-- Batch runs — live progress state for the weekly content batch.
--
-- The batch (lib/batch/weekly.ts) runs asynchronously in after(), so the client
-- can't watch it directly. This table is the poll surface: the pipeline updates
-- one row as it works (finding sources → drafting 1/5, 2/5, ... → done), and the
-- client polls GET /api/batch/weekly to render live, step-by-step feedback and a
-- settlement toast. Without this the UI could only guess with a fixed timer.
--
-- One ACTIVE run per workspace at a time (the app enforces this + the cooldown);
-- historical rows are kept for the "last batch" summary + debugging. Workspace-
-- scoped + RLS-isolated, matching every other per-workspace table.
--
--   status  : pending → running → done | failed
--   stage   : short human label of the current step, shown live in the UI
--   total   : how many drafts this run is trying to produce (the target)
--   attempted / created : progress counters the pipeline bumps as it goes
--   error   : populated only on failure, surfaced to the user
--
-- Idempotent: create-if-not-exists + drop-then-create policy. Safe to re-run.

create table if not exists batch_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed')),
  -- Short human-readable current step (e.g. "Finding this week's top posts",
  -- "Drafting 3 of 5 in your voice", "Done"). The UI shows this verbatim.
  stage text,
  total integer not null default 0,
  attempted integer not null default 0,
  created integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Latest run per workspace (the poll + "last batch" lookup).
create index if not exists batch_runs_workspace_idx
  on batch_runs(workspace_id, started_at desc);

alter table batch_runs enable row level security;
drop policy if exists batch_runs_isolation on batch_runs;
create policy batch_runs_isolation on batch_runs
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
