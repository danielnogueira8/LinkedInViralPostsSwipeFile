-- migration-040-custom-categories.sql
--
-- Lets a workspace create its own custom creator categories, alongside the 9
-- curated/global buckets from migration-015.
--
-- Design (locked decisions):
--   * Scope: workspace-private. A custom category is visible only to the
--     workspace that created it. The 9 curated rows stay global.
--   * Identity: curated rows keep their human slug ids ('ai', 'seo', ...) with
--     workspace_id = NULL. Custom rows get a generated UUID-string id so two
--     workspaces can both create "Crypto" without colliding on the text PK.
--   * Applies to: custom categories are only ever assigned to creators a
--     workspace adds by hand (accounts.source = 'manual'). The manual-add route
--     enforces this; nothing here needs to change about accounts.category_id,
--     which already references categories(id).
--
-- This migration is idempotent and safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. workspace_id column
--    NULL  = curated/global category (visible to every workspace)
--    set   = custom category, private to that workspace
-- ---------------------------------------------------------------------------
alter table categories
  add column if not exists workspace_id text;

create index if not exists categories_workspace_idx
  on categories(workspace_id);

-- Backfill: every pre-existing category is a curated/global one.
update categories set workspace_id = null where false; -- no-op; documents intent

-- A workspace can't create two categories with the same label. Curated rows
-- (workspace_id IS NULL) are exempt — this partial unique index only covers
-- workspace-owned rows. Case-insensitive so "Crypto" and "crypto" collide.
create unique index if not exists categories_workspace_label_unique
  on categories(workspace_id, lower(label))
  where workspace_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Row-Level Security
--    Reads: a workspace sees curated rows + its own custom rows.
--    Writes: a workspace may only insert/update/delete its OWN custom rows
--            (workspace_id = its id). Curated rows stay service-role only.
--
--    The app talks to this table via the service-role key (scopedSupabase),
--    which bypasses RLS — isolation there is enforced in app code. RLS is the
--    belt-and-suspenders backstop, matching the pattern in migration-011.
-- ---------------------------------------------------------------------------
alter table categories enable row level security;

drop policy if exists categories_read on categories;
create policy categories_read on categories
  for select using (
    workspace_id is null
    or workspace_id = auth_workspace_id()
  );

drop policy if exists categories_write_own on categories;
create policy categories_write_own on categories
  for all
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

commit;
