-- Migration 153: private workspace defaults for new LeadShark automations.

begin;

create table if not exists public.leadshark_automation_defaults (
  workspace_id text primary key,
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.leadshark_automation_defaults enable row level security;

drop policy if exists leadshark_automation_defaults_isolation
  on public.leadshark_automation_defaults;
create policy leadshark_automation_defaults_isolation
  on public.leadshark_automation_defaults
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

revoke all on table public.leadshark_automation_defaults
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.leadshark_automation_defaults to authenticated, service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 153, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
