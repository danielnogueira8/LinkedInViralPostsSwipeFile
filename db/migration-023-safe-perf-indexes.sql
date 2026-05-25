-- Migration 023: three index-only perf wins (behavior-preserving)
--
-- Each is a CREATE INDEX IF NOT EXISTS — no data change, no semantic
-- change, identical query results, just faster planning. Idempotent.

-- 1. saved_post_overrides — shared-library page reads
--    WHERE recipient_user_id = ? AND saved_post_id IN (...page of 24 ids).
--    Migration 021 only indexed (recipient_user_id) alone, and the
--    unique constraint indexes (saved_post_id, recipient_user_id) —
--    wrong leading column for this query. A (recipient_user_id,
--    saved_post_id) composite serves the filter + the IN-list directly.
create index if not exists saved_post_overrides_recipient_post_idx
  on saved_post_overrides (recipient_user_id, saved_post_id);

-- 2. templates — the Templates page does ORDER BY generated_at DESC
--    LIMIT 100 with no supporting index (only PK + unique(post_id)),
--    forcing a full scan + sort every visit.
create index if not exists templates_generated_at_idx
  on templates (generated_at desc);

-- 3. accounts — the Accounts page fetches the global catalog with
--    WHERE archived_at IS NULL ORDER BY name. migration-010's
--    accounts_active_idx is (id) WHERE archived_at IS NULL — it covers
--    the filter but not the name sort, so the catalog is sorted in
--    memory on every visit. A partial index on (name) covers both.
create index if not exists accounts_active_name_idx
  on accounts (name)
  where archived_at is null;
