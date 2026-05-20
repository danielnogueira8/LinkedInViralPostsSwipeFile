-- Migration 011: Multi-tenancy via Clerk Organizations
--
-- Design (locked decisions):
--   1a. workspace_id = Clerk org_id (text). No local workspaces table.
--   2b. accounts stays global; workspace_accounts join scopes which workspace tracks which creator.
--       posts/templates stay global (one scrape, many viewers).
--   3a. RLS ON; policies read workspace from auth.jwt() ->> 'org_id' (Clerk Supabase template).
--   4b. clients are children of a workspace (Scale Content Labs workspace has many ghostwriting clients).
--
-- Run order: this migration is idempotent and safe to re-run.
-- Existing data is backfilled into a seed workspace so prod keeps working.

-- ---------------------------------------------------------------------------
-- 0. Seed workspace id for backfilling pre-multi-tenancy rows
-- ---------------------------------------------------------------------------
-- Replace with the real Clerk org_id for Scale Content Labs once known.
-- Using a sentinel string now so the migration is deterministic; you can
-- UPDATE ... SET workspace_id = '<real org id>' WHERE workspace_id = 'org_seed_scl'
-- after creating the org in Clerk.
do $$
declare
  seed_workspace constant text := 'org_seed_scl';
begin
  perform set_config('app.seed_workspace', seed_workspace, false);
end$$;

-- ---------------------------------------------------------------------------
-- 1. workspace_accounts: per-workspace selection of which global accounts to track
-- ---------------------------------------------------------------------------
create table if not exists workspace_accounts (
  workspace_id text not null,
  account_id uuid not null references accounts(id) on delete cascade,
  niche text,                        -- per-workspace niche override (nullable = inherit accounts.niche)
  added_at timestamptz not null default now(),
  primary key (workspace_id, account_id)
);

create index if not exists workspace_accounts_workspace_idx on workspace_accounts(workspace_id);
create index if not exists workspace_accounts_account_idx on workspace_accounts(account_id);

-- Backfill: every existing account belongs to the seed workspace.
insert into workspace_accounts (workspace_id, account_id, niche)
select current_setting('app.seed_workspace'), id, niche
from accounts
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. clients: add workspace_id (child of workspace)
-- ---------------------------------------------------------------------------
alter table clients add column if not exists workspace_id text;
update clients set workspace_id = current_setting('app.seed_workspace') where workspace_id is null;
alter table clients alter column workspace_id set not null;
create index if not exists clients_workspace_idx on clients(workspace_id);

-- ---------------------------------------------------------------------------
-- 3. image_prompts: add workspace_id (derived from client's workspace)
-- ---------------------------------------------------------------------------
alter table image_prompts add column if not exists workspace_id text;
update image_prompts ip
  set workspace_id = c.workspace_id
  from clients c
  where ip.client_id = c.id and ip.workspace_id is null;
alter table image_prompts alter column workspace_id set not null;
create index if not exists image_prompts_workspace_idx on image_prompts(workspace_id);

-- ---------------------------------------------------------------------------
-- 4. runs: add workspace_id (nullable — daily cron runs are global)
-- ---------------------------------------------------------------------------
-- A run is global when null (the once-a-day shared scrape), workspace-scoped
-- when triggered by a workspace (e.g. manual re-scrape of one account).
alter table runs add column if not exists workspace_id text;
create index if not exists runs_workspace_idx on runs(workspace_id);

-- ---------------------------------------------------------------------------
-- 5. settings: become per-workspace
-- ---------------------------------------------------------------------------
-- Old shape: key (pk), value. New shape: (workspace_id, key) composite pk.
-- Existing global settings get copied into the seed workspace.
alter table settings add column if not exists workspace_id text;
update settings set workspace_id = current_setting('app.seed_workspace') where workspace_id is null;
alter table settings alter column workspace_id set not null;

-- Swap primary key from (key) to (workspace_id, key).
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'settings_pkey' and conrelid = 'settings'::regclass
  ) then
    alter table settings drop constraint settings_pkey;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'settings_workspace_key_pkey' and conrelid = 'settings'::regclass
  ) then
    alter table settings add constraint settings_workspace_key_pkey primary key (workspace_id, key);
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 6. Row-Level Security
-- ---------------------------------------------------------------------------
-- Helper: extract workspace id from Clerk JWT (Clerk Supabase template puts org_id at top level).
create or replace function auth_workspace_id() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'org_id', '')
$$;

-- workspace_accounts: workspace can only see/modify its own rows
alter table workspace_accounts enable row level security;
drop policy if exists workspace_accounts_isolation on workspace_accounts;
create policy workspace_accounts_isolation on workspace_accounts
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

-- clients
alter table clients enable row level security;
drop policy if exists clients_isolation on clients;
create policy clients_isolation on clients
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

-- image_prompts
alter table image_prompts enable row level security;
drop policy if exists image_prompts_isolation on image_prompts;
create policy image_prompts_isolation on image_prompts
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

-- runs: workspace sees its own runs + global (null) runs
alter table runs enable row level security;
drop policy if exists runs_isolation on runs;
create policy runs_isolation on runs
  using (workspace_id is null or workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

-- settings
alter table settings enable row level security;
drop policy if exists settings_isolation on settings;
create policy settings_isolation on settings
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

-- accounts (global catalog): readable to any authenticated workspace, writes restricted to service role.
-- Workspaces should NOT directly insert/update accounts — that's the cron job's job (service role bypasses RLS).
alter table accounts enable row level security;
drop policy if exists accounts_read_all on accounts;
create policy accounts_read_all on accounts
  for select using (auth_workspace_id() is not null);

-- posts (global): same model as accounts. Readable if the workspace tracks the post's account.
alter table posts enable row level security;
drop policy if exists posts_read_via_tracking on posts;
create policy posts_read_via_tracking on posts
  for select using (
    exists (
      select 1 from workspace_accounts wa
      where wa.account_id = posts.account_id
        and wa.workspace_id = auth_workspace_id()
    )
  );

-- templates (global): visible if the workspace can see the underlying post.
alter table templates enable row level security;
drop policy if exists templates_read_via_post on templates;
create policy templates_read_via_post on templates
  for select using (
    exists (
      select 1 from posts p
      join workspace_accounts wa on wa.account_id = p.account_id
      where p.id = templates.post_id
        and wa.workspace_id = auth_workspace_id()
    )
  );

-- ---------------------------------------------------------------------------
-- 7. Seed default settings for the seed workspace if missing
-- ---------------------------------------------------------------------------
insert into settings (workspace_id, key, value) values
  (current_setting('app.seed_workspace'), 'viral_thresholds', '{"min_reactions": 200, "min_comments": 50}'::jsonb),
  (current_setting('app.seed_workspace'), 'template_thresholds', '{"min_reactions": 500, "min_comments": 100}'::jsonb)
on conflict (workspace_id, key) do nothing;
