-- Migration 151: retry LeadShark bindings affected by share/activity URN drift.
--
-- Zernio can return a LinkedIn share URN whose numeric id differs from the
-- canonical activity URN LeadShark requires. Before the canonical lookup fix,
-- those jobs exhausted their six attempts and parked in awaiting_urn with a
-- misleading "post list hasn't caught up" error.
--
-- Requeue only rows with that exact failure shape. The update and queue insert
-- share one statement/transaction, so a recovered automation cannot be left in
-- binding without a job. Existing open jobs make the row ineligible, and the
-- status transition makes this migration safe against duplicate queue entries.
--
-- Apply this data migration only after the canonical activity-URN resolver is
-- deployed. Applying it first would let an old worker consume the retry with
-- the same broken resolver.

begin;

with recovery_candidates as (
  update public.leadshark_automations automation
  set
    status = 'binding',
    bind_attempts = 0,
    last_error =
      'Retrying with corrected LinkedIn activity-URN resolution.',
    last_error_code = 'canonical_activity_retry',
    updated_at = now()
  where automation.status = 'awaiting_urn'
    and automation.last_error_code = 'pending'
    and automation.leadshark_automation_id is null
    and automation.zernio_post_urn like 'urn:li:share:%'
    and automation.zernio_post_url like 'https://%.linkedin.com/%'
    and automation.bind_attempts = 6
    and not exists (
      select 1
      from public.background_jobs job
      where job.workspace_id = automation.workspace_id
        and job.type = 'leadshark_bind_automation'
        and job.status in ('queued', 'running')
        and job.payload ->> 'automationId' = automation.id::text
    )
  returning automation.id, automation.workspace_id
)
insert into public.background_jobs (
  workspace_id,
  type,
  status,
  payload,
  progress,
  max_attempts,
  run_after
)
select
  candidate.workspace_id,
  'leadshark_bind_automation',
  'queued',
  jsonb_build_object('automationId', candidate.id),
  '{}'::jsonb,
  6 as max_attempts,
  now()
from recovery_candidates candidate;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 151, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
