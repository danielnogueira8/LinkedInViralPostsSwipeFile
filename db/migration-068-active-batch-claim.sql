-- Enforce one live weekly batch per workspace across all serverless instances.
-- Keep the newest active row if legacy races already created duplicates.
with ranked as (
  select id,
         row_number() over (partition by workspace_id order by updated_at desc, started_at desc) as rn
  from batch_runs
  where status in ('pending', 'running')
)
update batch_runs b
set status = 'failed',
    stage = 'Superseded duplicate run',
    error = 'Duplicate active batch repaired during migration 068.',
    finished_at = now(),
    updated_at = now()
from ranked r
where b.id = r.id and r.rn > 1;

create unique index if not exists batch_runs_one_active_per_workspace
  on batch_runs(workspace_id)
  where status in ('pending', 'running');
