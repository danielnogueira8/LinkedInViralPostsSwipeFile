-- Migration 020: Lowercase accounts.profile_url
--
-- Sheet sync (lib/sheets.ts) now writes lowercase profile_url on insert
-- (PR #85). Manual flow already lowercased via normalizeProfileUrl(). But
-- any rows inserted before the sheet-sync fix can be mixed-case, and
-- since the unique index is case-sensitive that means:
--
--   - Two near-duplicate rows ("...john-doe" + "...John-Doe") can both exist
--   - Future upserts using `onConflict: "profile_url"` will miss the
--     canonical row and create yet another duplicate
--
-- This migration:
--   1. Identifies any mixed-case rows
--   2. For collisions (lowercased URL already exists on another row),
--      we KEEP the row with the most recent synced_at and delete the
--      stale duplicate (which would otherwise block the UPDATE).
--   3. Lowercases the survivors in place.
--
-- Idempotent — running it again is a no-op.
--
-- Safety: workspace_accounts.account_id has ON DELETE CASCADE in
-- migration 011, so deleting a duplicate global account also untracks
-- it from any workspace. That's the intended behavior — duplicates
-- shouldn't be tracked.

begin;

-- Step 1: For each lowercased URL, keep only the row with the latest
-- synced_at. Delete the rest. (If synced_at ties, ctid breaks the tie
-- deterministically.)
with ranked as (
  select
    id,
    lower(profile_url) as lc_url,
    row_number() over (
      partition by lower(profile_url)
      order by synced_at desc nulls last, ctid
    ) as rn
  from accounts
)
delete from accounts
where id in (select id from ranked where rn > 1);

-- Step 2: Lowercase the survivors. The unique index allows this because
-- step 1 removed all collisions.
update accounts
   set profile_url = lower(profile_url)
 where profile_url <> lower(profile_url);

commit;
