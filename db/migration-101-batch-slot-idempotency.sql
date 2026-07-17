-- Migration 101: Idempotent batch_draft_slots so a requeued weekly-batch job
-- can't duplicate work already done by the attempt it's replacing.
--
-- Weekly-batch jobs run through the standard background-job retry path
-- (lib/background-job-worker.ts): on a thrown error (narrow today — only
-- UsagePersistenceError propagates past the per-worker catch, but the retry
-- machinery itself doesn't know that), the job is requeued and re-run with the
-- SAME batch_id. runWeeklyBatch then re-creates slot rows and re-drafts every
-- source from scratch, including slots the first attempt already filed before
-- the fatal error hit a sibling worker — because batch_draft_slots had no
-- uniqueness constraint on (workspace_id, batch_id, slot_index), the second
-- attempt's createBatchSlots() insert just adds a second row per slot instead
-- of colliding with the first, and insertBatchDraft() has no idempotency
-- check at all, so the same logical slot can end up with two separate
-- chat_artifacts rows.
--
-- Fix: a unique constraint on the natural key. lib/batch/weekly.ts is updated
-- alongside this migration to (a) upsert slots on that key instead of a raw
-- insert, and (b) skip a worker entirely if its slot already shows status
-- 'filed' when the worker starts — so a requeued run picks up only the slots
-- that didn't finish, not the ones that already did.
--
-- Live-confirmed: applying this constraint to prod without a dedup step
-- failed with a duplicate-key error — this bug already produced real
-- duplicate rows.
--
-- Run order: idempotent (drop-then-create constraint via a DO block guard;
-- the dedup delete is also safe to re-run — it's a no-op once no duplicates
-- remain). This app already produced duplicate rows pre-fix, so the
-- constraint would fail to create without cleaning those up first.
--
-- Dedup rule per (workspace_id, batch_id, slot_index) group: keep the 'filed'
-- row if one exists (it has a real chat_artifacts draft attached — the row
-- most likely to be linked from elsewhere), otherwise keep the most recently
-- updated row. Delete the rest.

delete from batch_draft_slots s
using (
  select
    id,
    row_number() over (
      partition by workspace_id, batch_id, slot_index
      order by (status = 'filed') desc, updated_at desc
    ) as rn
  from batch_draft_slots
) ranked
where s.id = ranked.id
  and ranked.rn > 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'batch_draft_slots_unique_slot'
  ) then
    alter table batch_draft_slots
      add constraint batch_draft_slots_unique_slot
      unique (workspace_id, batch_id, slot_index);
  end if;
end $$;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 101, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
