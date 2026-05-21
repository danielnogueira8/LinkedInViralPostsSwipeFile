-- migration-015-collapse-categories.sql
--
-- Cleans up the categories taxonomy after drift from earlier experiments and
-- collapses LinkedIn + LinkedIn Content into a single LinkedIn Content bucket.
--
-- Background:
--   * The `categories` table grew 8 ghost rows from an abandoned alt-taxonomy
--     (linkedin-growth, ai-automation, gtm-outreach, paid-ads, personal-brand,
--     email-marketing, agency-ops, other). None of them are referenced by any
--     accounts.category_id, so they're safe to delete.
--   * `LinkedIn` and `LinkedIn Content` had blurry overlap. We collapse to a
--     single `linkedin-content` slug ("LinkedIn Content" label) — every prior
--     LinkedIn-bucket creator (personal brand, ghostwriting, agencies & LI)
--     fits cleanly under LinkedIn Content.
--   * `workspace_accounts.niche` was holding free-form unnormalized strings
--     from the original sheet sync (36 distinct values: "AI Automation /
--     No-code", "GAMES", "LinkedIn / Cold Email", etc.). None of them are
--     intentional per-workspace overrides, so we wipe the column. The MCP
--     "effective niche" reader COALESCEs over accounts.niche anyway, so
--     readers degrade cleanly to the global value.
--   * `accounts.niche` gets the canonical 9-name normalization applied here
--     instead of (also) in scripts/normalize-niches.mjs — keeps the migration
--     self-contained.
--
-- Final canonical taxonomy (9 categories):
--   LinkedIn Content, AI, Automation, Outreach, GTM, Ads, SEO,
--   Agency Operations, Investor.
--
-- This migration is idempotent and safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Re-point any accounts/workspace_accounts pointing at the old `linkedin`
--    slug to `linkedin-content` BEFORE we drop the row (FK constraint safety).
-- ---------------------------------------------------------------------------
update accounts            set category_id = 'linkedin-content' where category_id = 'linkedin';
update workspace_accounts  set category_id = 'linkedin-content' where category_id = 'linkedin';

-- ---------------------------------------------------------------------------
-- 2. Delete ghost category rows (alt-taxonomy that nothing references).
--    `linkedin` is also deleted now that #1 moved its FK refs.
-- ---------------------------------------------------------------------------
delete from categories where id in (
  'linkedin',
  'linkedin-growth',
  'ai-automation',
  'gtm-outreach',
  'paid-ads',
  'personal-brand',
  'email-marketing',
  'agency-ops',
  'other'
);

-- ---------------------------------------------------------------------------
-- 3. Re-assert sort order for the canonical 9 (re-runnable, fixes any drift
--    from earlier upserts).
-- ---------------------------------------------------------------------------
insert into categories (id, label, sort_order) values
  ('linkedin-content',  'LinkedIn Content',  10),
  ('ai',                'AI',                20),
  ('automation',        'Automation',        30),
  ('outreach',          'Outreach',          40),
  ('gtm',               'GTM',               50),
  ('ads',               'Ads',               60),
  ('seo',               'SEO',               70),
  ('agency-operations', 'Agency Operations', 80),
  ('investor',          'Investor',          90)
on conflict (id) do update
  set label      = excluded.label,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 4. Normalize accounts.niche so every row matches one of the 9 canonical
--    labels (or stays NULL). Same rules as scripts/normalize-niches.mjs, but
--    with LinkedIn collapsed into LinkedIn Content.
-- ---------------------------------------------------------------------------

-- AI family
update accounts set niche = 'AI'
 where niche is not null and (
   niche ~* '^ai\b'
   or niche ~* '^no-?code$'
   or niche ~* '^video\s*/?\s*ai$'
 );

-- Ads family
update accounts set niche = 'Ads'
 where niche is not null and (
   niche ~* '^ads(\s*\+\s*ugc)?$'
   or niche ~* '^(paid|google|meta)\s+ads$'
 );

-- Outreach family
update accounts set niche = 'Outreach'
 where niche is not null and (
   niche ~* '^cold\s+email(\s*/?\s*(ai|gtm))?$'
   or niche ~* '^linkedin\s*/?\s*cold\s+email$'
   or niche ~* '^(linkedin\s+)?outreach$'
   or niche ~* '^sms$'
   or niche ~* '^lead\s+gen$'
 );

-- LinkedIn Content family (absorbs old "LinkedIn", "Personal Brand",
-- "Agencies & LinkedIn", "Ghostwriting", and "LinkedIn Content" itself).
update accounts set niche = 'LinkedIn Content'
 where niche is not null and (
   niche ~* '^linkedin$'
   or niche ~* '^linkedin\s+content$'
   or niche ~* '^agencies?\s*&\s*linkedin$'
   or niche ~* '^personal\s+brand$'
   or niche ~* '^ghostwriting$'
 );

-- Automation
update accounts set niche = 'Automation'
 where niche is not null and niche ~* '^automation$';

-- GTM / Marketing
update accounts set niche = 'GTM'
 where niche is not null and (
   niche ~* '^gtm$'
   or niche ~* '^marketing$'
   or niche ~* '^email\s+marketing$'
 );

-- SEO / Agency Operations / Investor — already canonical, but force-fix case.
update accounts set niche = 'SEO'               where niche is not null and niche ~* '^seo$';
update accounts set niche = 'Agency Operations' where niche is not null and niche ~* '^agency\s+operations$';
update accounts set niche = 'Investor'          where niche is not null and niche ~* '^investor$';

-- ---------------------------------------------------------------------------
-- 5. Backfill accounts.category_id from the now-canonical niche. Only fills
--    rows where category_id is NULL or points at a slug we just deleted (none
--    should remain, but defensive).
-- ---------------------------------------------------------------------------
update accounts set category_id = 'ai'                where niche = 'AI'                and (category_id is null or category_id not in (select id from categories));
update accounts set category_id = 'linkedin-content' where niche = 'LinkedIn Content' and (category_id is null or category_id not in (select id from categories));
update accounts set category_id = 'outreach'          where niche = 'Outreach'          and (category_id is null or category_id not in (select id from categories));
update accounts set category_id = 'gtm'               where niche = 'GTM'               and (category_id is null or category_id not in (select id from categories));
update accounts set category_id = 'ads'               where niche = 'Ads'               and (category_id is null or category_id not in (select id from categories));
update accounts set category_id = 'seo'               where niche = 'SEO'               and (category_id is null or category_id not in (select id from categories));
update accounts set category_id = 'agency-operations' where niche = 'Agency Operations' and (category_id is null or category_id not in (select id from categories));
update accounts set category_id = 'automation'        where niche = 'Automation'        and (category_id is null or category_id not in (select id from categories));
update accounts set category_id = 'investor'          where niche = 'Investor'          and (category_id is null or category_id not in (select id from categories));

-- ---------------------------------------------------------------------------
-- 5b. Sync niche label to category label for stragglers (e.g. Robbie
--    Ferguson's "GAMES" niche, which has category_id='gtm' from migration-012
--    but never got a niche-label refresh). After this, accounts.niche always
--    equals the canonical label of accounts.category_id.
-- ---------------------------------------------------------------------------
update accounts a
   set niche = c.label
  from categories c
 where a.category_id = c.id
   and (a.niche is distinct from c.label);

-- ---------------------------------------------------------------------------
-- 6. Wipe workspace_accounts.niche overrides. They were leftover unnormalized
--    sheet-sync junk, not intentional per-workspace tweaks. Readers COALESCE
--    over accounts.niche so this is a clean default.
-- ---------------------------------------------------------------------------
update workspace_accounts set niche = null where niche is not null;

-- ---------------------------------------------------------------------------
-- 7. Sanity check.
-- ---------------------------------------------------------------------------
do $$
declare
  unmapped int;
  bad_niche int;
  cat_count int;
begin
  select count(*) into unmapped from accounts where category_id is null;
  if unmapped > 0 then
    raise notice 'migration-015: % accounts have category_id IS NULL — set them via /api/accounts/manual or run normalize-niches.mjs --apply', unmapped;
  end if;

  select count(*) into bad_niche from accounts
   where niche is not null
     and niche not in (
       'LinkedIn Content','AI','Automation','Outreach','GTM','Ads','SEO','Agency Operations','Investor'
     );
  if bad_niche > 0 then
    raise notice 'migration-015: % accounts still have non-canonical niche values — investigate', bad_niche;
  end if;

  select count(*) into cat_count from categories;
  if cat_count <> 9 then
    raise notice 'migration-015: expected 9 categories, found % — investigate', cat_count;
  end if;
end$$;

commit;
