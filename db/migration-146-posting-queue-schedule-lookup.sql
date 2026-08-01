-- Migration 146: keep the minute-by-minute posting queue lookup
-- workspace-first as one-off schedules grow.

begin;

create index if not exists chat_artifacts_workspace_active_schedule_idx
  on public.chat_artifacts (
    workspace_id,
    schedule_status,
    scheduled_at
  )
  where scheduled_at is not null
    and schedule_status in ('scheduled', 'publishing', 'failed');

insert into public.app_schema_version (
  singleton,
  version,
  updated_at
)
values (true, 146, now())
on conflict (singleton) do update
set
  version = excluded.version,
  updated_at = excluded.updated_at;

commit;
