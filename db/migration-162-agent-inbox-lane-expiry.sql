-- Migration 162: every agent-inbox lane expires, and existing rows get a
-- deadline.
--
-- Only `newsjacking` ever set expires_at (72h). The other three lanes stored
-- NULL, so their ideas never aged out. Once a lane reached the 3-active cap it
-- was permanently "full": replenish() computes missingLanes as the lanes BELOW
-- the cap, so a full lane is never requested again and never regenerates. The
-- daily run kept completing successfully while creating nothing, which is what
-- a frozen board looks like from the outside.
--
-- Observed shape of the bug (workspace with a 2026-08-01 run):
--   requested_lanes = ["personal_story","namejacking"]  -- educational and
--   newsjacking were already full, so they were not even attempted.
--
-- The code now stamps every new idea via laneLifetimeHours(). This migration
-- backfills the rows that already exist, so today's stale board turns over
-- instead of waiting for someone to discard each card by hand.
--
-- Lifetimes match lib/agent-inbox/index.ts — keep the two in sync:
--   newsjacking     72h   a timely pitch genuinely rots
--   namejacking    120h   anchored to a name, which outlives the headline
--   educational    168h   evergreen material, but the ANGLE should be weekly
--   personal_story 168h   same
--
-- Deliberately dated from created_at, not from now(): an idea that has been
-- sitting for two weeks should fall out on the next sweep, not get a fresh
-- week's lease it never earned. Rows whose deadline is already past are left
-- for release_due_agent_inbox_ideas() to expire on its next run, which is the
-- existing, tested path — this migration does not change statuses itself.

begin;

update public.agent_inbox_ideas
set expires_at = created_at + case lane
      when 'newsjacking' then interval '72 hours'
      when 'namejacking' then interval '120 hours'
      else interval '168 hours'
    end,
    updated_at = now()
where expires_at is null
  and status in ('active', 'snoozed');

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 162, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
