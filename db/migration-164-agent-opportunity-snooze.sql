-- Migration 164: give Trend Radar the same defer action as Agent Inbox lanes.
--
-- Trend Radar cards now render in the shared five-agent inbox. A temporary
-- "Not today" decision must therefore be reversible in exactly the same way
-- as an Agent Inbox idea; dismiss remains the permanent negative signal.

begin;

alter table public.agent_opportunities
  add column if not exists snoozed_until timestamptz;

alter table public.agent_opportunities
  drop constraint if exists agent_opportunities_status_check;

alter table public.agent_opportunities
  add constraint agent_opportunities_status_check
  check (status in ('proposed','drafting','drafted','dismissed','expired','snoozed'));

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 164, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
