-- Migration 170: distinguish a Cowork handoff from a generated draft.
--
-- A recommendation is complete once its prompt has successfully entered a new
-- Cowork session, but that does not mean the user has generated a draft yet.

begin;

alter table public.agent_opportunities
  drop constraint if exists agent_opportunities_status_check;

alter table public.agent_opportunities
  add constraint agent_opportunities_status_check
  check (status in ('proposed','drafting','drafted','dismissed','expired','snoozed','handled'));

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 170, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
