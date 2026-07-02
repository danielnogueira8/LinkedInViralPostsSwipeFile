-- Batch draft slots — one row per "worker" in a weekly batch run.
--
-- The batch now runs as a team of parallel agents: it picks N source posts, then
-- adapts them into the user's voice CONCURRENTLY, and the UI shows one live lane
-- per source (the "agent workers board"). Each lane needs its OWN state — which
-- source it grabbed, which skill it's applying, whether it's drafting / filed /
-- skipped — which the single batch_runs row (global counters only) can't hold.
-- This table is that per-worker state; the UI polls it to render the lanes.
--
-- A slot is created UP FRONT (status 'queued') the moment sources are picked, so
-- the board can show WHAT is being adapted before any draft exists. It advances
-- to 'drafting' when its worker starts, then 'filed' (artifact_id set), 'skipped'
-- (the model couldn't produce a usable post), or 'failed' (an error). batch_runs
-- stays as the run-level rollup.
--
-- Workspace-scoped + RLS, matching every other per-workspace table.
--
-- Idempotent: create-if-not-exists + drop-then-create policy. Safe to re-run.

create table if not exists batch_draft_slots (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- The run this slot belongs to (matches batch_runs.id + the meta.batch_id on
  -- the resulting chat_artifacts row). Not a hard FK: batch_runs may be pruned.
  batch_id uuid not null,
  -- Position in the batch (0-based), so the board renders lanes in a stable order.
  slot_index integer not null,
  -- The source post being adapted, surfaced to the user BEFORE its draft lands.
  source_post_id text,
  source_first_line text,
  source_url text,
  post_type text,
  is_lead_magnet boolean not null default false,
  -- Human label of the voice/skill this worker applies ("Your voice" /
  -- "Lead-magnet voice"), shown as a chip on the lane.
  skill_label text,
  status text not null default 'queued'
    check (status in ('queued', 'drafting', 'filed', 'skipped', 'failed')),
  -- The chat_artifacts row this worker produced (set when status = 'filed').
  artifact_id uuid,
  -- The filed draft's title, so the lane can show the result without a join.
  draft_title text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fetch a run's slots in order (the board poll).
create index if not exists batch_draft_slots_batch_idx
  on batch_draft_slots(workspace_id, batch_id, slot_index);

alter table batch_draft_slots enable row level security;
drop policy if exists batch_draft_slots_isolation on batch_draft_slots;
create policy batch_draft_slots_isolation on batch_draft_slots
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
