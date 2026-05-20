-- migration-012-categories.sql
--
-- Introduces a `categories` table to group accounts into curated buckets for
-- onboarding (PR-2 will use this for the category picker / bulk-track flow).
--
-- Pre-req: run scripts/normalize-niches.mjs --apply FIRST so accounts.niche
-- holds the canonical 10-name values listed below. If you skip that step, the
-- backfill in section 3 will leave category_id NULL for non-canonical rows.
--
-- Categories (10): AI, LinkedIn, Outreach, SEO, GTM, Ads, Agency Operations,
-- LinkedIn Content, Automation, Investor.
-- Removed from prior taxonomy: GAMES (lone account reassigned to GTM below).
--
-- This migration is idempotent and safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. categories table (curated taxonomy)
-- ---------------------------------------------------------------------------
create table if not exists categories (
  id          text primary key,                       -- slug
  label       text not null,                          -- display name
  description text,                                   -- shown in onboarding picker (nullable for now)
  sort_order  int  not null default 0,
  is_curated  boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into categories (id, label, sort_order) values
  ('linkedin',          'LinkedIn',          10),
  ('linkedin-content',  'LinkedIn Content',  20),
  ('ai',                'AI',                30),
  ('automation',        'Automation',        40),
  ('outreach',          'Outreach',          50),
  ('gtm',               'GTM',               60),
  ('ads',               'Ads',               70),
  ('seo',               'SEO',               80),
  ('agency-operations', 'Agency Operations', 90),
  ('investor',          'Investor',         100)
on conflict (id) do update
  set label      = excluded.label,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 2. category_id columns
--    Mirrors the niche pattern from migration-011:
--      - accounts.category_id      = default bucket (curated)
--      - workspace_accounts.category_id = per-workspace override (nullable)
-- ---------------------------------------------------------------------------
alter table accounts
  add column if not exists category_id text references categories(id);

alter table workspace_accounts
  add column if not exists category_id text references categories(id);

create index if not exists accounts_category_idx
  on accounts(category_id);
create index if not exists workspace_accounts_category_idx
  on workspace_accounts(category_id);

-- ---------------------------------------------------------------------------
-- 3. Backfill accounts.category_id from the canonical niche value
--    Assumes normalize-niches.mjs --apply has been run with the updated RULES
--    (^ghostwriting$ -> LinkedIn Content, ^linkedin\s+content$ -> LinkedIn Content,
--     ^automation$ -> Automation).
-- ---------------------------------------------------------------------------
update accounts set category_id = 'ai'                where niche = 'AI'                and category_id is null;
update accounts set category_id = 'linkedin'          where niche = 'LinkedIn'          and category_id is null;
update accounts set category_id = 'linkedin-content' where niche = 'LinkedIn Content' and category_id is null;
update accounts set category_id = 'outreach'          where niche = 'Outreach'          and category_id is null;
update accounts set category_id = 'gtm'               where niche = 'GTM'               and category_id is null;
update accounts set category_id = 'ads'               where niche = 'Ads'               and category_id is null;
update accounts set category_id = 'seo'               where niche = 'SEO'               and category_id is null;
update accounts set category_id = 'agency-operations' where niche = 'Agency Operations' and category_id is null;
update accounts set category_id = 'automation'        where niche = 'Automation'        and category_id is null;
update accounts set category_id = 'investor'          where niche = 'Investor'          and category_id is null;

-- ---------------------------------------------------------------------------
-- 4. Explicit per-account overrides (judgment calls, not regex patterns)
-- ---------------------------------------------------------------------------
-- 4a. Robbie Ferguson — was niche='GAMES'. GAMES category dropped; reassigning
--     to GTM (gaming-on-LinkedIn ≈ marketing). Override if wrong.
update accounts
   set category_id = 'gtm'
 where id = '7b93265b-81e4-4fc0-bf1b-3ff2fa9b6544';

-- 4b. Michel Lieben — was niche='LinkedIn / Cold Email'. normalize-niches
--     routes this to Outreach by rule order, but the creator listed LinkedIn
--     first; respecting author intent.
update accounts
   set category_id = 'linkedin'
 where id = '2beb0b2b-2e76-4941-b42b-58a2ff9aea64';

-- ---------------------------------------------------------------------------
-- 5. Mirror backfill into workspace_accounts.category_id
--    Per-workspace category starts as NULL (= inherit accounts.category_id),
--    matching the niche pattern. No backfill needed; readers should COALESCE
--    workspace_accounts.category_id over accounts.category_id at query time.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. Sanity check (raises notice if any account is missing a category)
-- ---------------------------------------------------------------------------
do $$
declare
  unmapped int;
begin
  select count(*) into unmapped from accounts where category_id is null;
  if unmapped > 0 then
    raise notice 'migration-012: % accounts have category_id IS NULL — run normalize-niches.mjs --apply or check raw niche values', unmapped;
  end if;
end$$;

commit;
