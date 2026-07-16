-- Rename the curated outreach category without changing its stable id, and
-- add Divyanshi Sharma to the shared creator catalog. The handle-keyed upsert
-- promotes an existing manual copy safely if one was added before migration.

begin;

update categories
set label = 'GTM/Outreach'
where id = 'outreach'
  and workspace_id is null;

-- Keep the legacy niche mirror aligned for integrations and agent contexts
-- that still expose accounts.niche instead of joining the category label.
update accounts
set niche = 'GTM/Outreach'
where category_id = 'outreach'
  and niche is distinct from 'GTM/Outreach';

-- A workspace niche can be a genuine custom override, so only rewrite the
-- exact former curated label for memberships already bound to this category.
update workspace_accounts
set niche = 'GTM/Outreach'
where category_id = 'outreach'
  and niche = 'Sales/Outreach';

insert into accounts (
  name,
  profile_url,
  linkedin_handle,
  niche,
  category_id,
  headline,
  recommendation_reason,
  discovery_tags,
  is_featured,
  source,
  manual_owner_workspace_id,
  archived_at,
  synced_at
)
select
  'Divyanshi Sharma',
  'https://www.linkedin.com/in/divyanshis-saasleadgen/',
  'divyanshis-saasleadgen',
  c.label,
  c.id,
  'Lead-generation systems and AI-powered outreach',
  'Practical examples of AI-assisted lead generation, outbound systems, and modern GTM execution.',
  array['gtm', 'outreach', 'lead generation', 'ai agents'],
  true,
  'sheet',
  null,
  null,
  now()
from categories c
where c.id = 'outreach'
  and c.workspace_id is null
on conflict ((lower(linkedin_handle))) do update set
  name = excluded.name,
  profile_url = excluded.profile_url,
  linkedin_handle = excluded.linkedin_handle,
  niche = excluded.niche,
  category_id = excluded.category_id,
  headline = excluded.headline,
  recommendation_reason = excluded.recommendation_reason,
  discovery_tags = excluded.discovery_tags,
  is_featured = true,
  source = 'sheet',
  manual_owner_workspace_id = null,
  archived_at = null,
  synced_at = excluded.synced_at;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 98, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
